"""Replayable, exchange-time one-minute candle engine for ATHENA.

This module is broker independent. The SmartAPI adapter is responsible for
price scaling and passes normalized prices/timestamps into MarketDataEngine.
Persisted timestamps are UTC epoch seconds; display conversion belongs to the
API/client boundary.
"""
from __future__ import annotations

from collections import OrderedDict, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any
from zoneinfo import ZoneInfo
from contextlib import closing


UTC = timezone.utc
IST = ZoneInfo("Asia/Kolkata")
TIMEFRAME = "1m"
MAX_CANDLES_PER_INSTRUMENT = 3_000


def parse_candle_time(value: Any) -> int:
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().isdigit()):
        raw = float(value)
        return int(raw / 1000) if raw > 10_000_000_000 else int(raw)
    parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=IST)
    return int(parsed.astimezone(UTC).timestamp())


def parse_event_time(value: Any, received_at: datetime | None = None) -> tuple[datetime, str]:
    """Parse SmartAPI epoch-millisecond or ISO time; explicitly label fallback."""
    received_at = received_at or datetime.now(UTC)
    if received_at.tzinfo is None:
        received_at = received_at.replace(tzinfo=UTC)
    try:
        if isinstance(value, str) and not value.strip().isdigit():
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            event_time = parsed.astimezone(UTC)
        else:
            stamp = int(value)
            # The SmartAPI V2 packet timestamp is epoch milliseconds.
            event_time = datetime.fromtimestamp(stamp / 1000, UTC)
        if not 946684800 <= event_time.timestamp() <= 4102444800:
            raise ValueError("implausible exchange timestamp")
        return event_time, "exchange"
    except (TypeError, ValueError, OverflowError, OSError):
        return received_at.astimezone(UTC), "receipt_fallback"


@dataclass(frozen=True)
class NormalizedTick:
    exchange_type: int
    token: str
    price: float
    event_time: datetime
    received_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    sequence_number: int | None = None
    timestamp_source: str = "exchange"

    @property
    def instrument_key(self) -> str:
        return f"{self.exchange_type}:{self.token}"


@dataclass
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: int | None = None
    status: str = "provisional"
    source: str = "websocket-derived"
    event_count: int = 0
    last_event_time: int = 0
    quality_flags: list[str] = field(default_factory=list)
    _open_order: tuple[int, int] = field(default_factory=lambda: (0, -1), repr=False)
    _close_order: tuple[int, int] = field(default_factory=lambda: (0, -1), repr=False)

    def public(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if not k.startswith("_")}


class CandleAggregator:
    """Per-exchange/token minute bars; gaps remain absent, never forward-filled."""

    def __init__(self, max_candles: int = MAX_CANDLES_PER_INSTRUMENT):
        self.max_candles = max_candles
        self._candles: dict[str, OrderedDict[int, Candle]] = {}
        self._seen_sequences: dict[str, deque[int]] = {}
        self._seen_sets: dict[str, set[int]] = {}
        self._lock = threading.RLock()

    def ingest(self, tick: NormalizedTick) -> tuple[Candle | None, list[Candle], bool]:
        if not tick.token or not isinstance(tick.exchange_type, int) or tick.exchange_type <= 0:
            return None, [], False
        if not math.isfinite(tick.price) or tick.price <= 0:
            return None, [], False
        event_time = tick.event_time
        if event_time.tzinfo is None:
            return None, [], False
        event_time = event_time.astimezone(UTC)
        epoch_ms = int(event_time.timestamp() * 1000)
        minute = epoch_ms // 60_000 * 60
        key = tick.instrument_key
        sequence = tick.sequence_number
        order = (epoch_ms, sequence if sequence is not None else 0)
        with self._lock:
            if sequence is not None:
                seen = self._seen_sets.setdefault(key, set())
                if sequence in seen:
                    return None, [], False
                history = self._seen_sequences.setdefault(key, deque())
                history.append(sequence)
                seen.add(sequence)
                while len(history) > 10_000:
                    seen.discard(history.popleft())

            bars = self._candles.setdefault(key, OrderedDict())
            older = [bar for start, bar in bars.items() if start < minute and bar.status == "provisional"]
            for bar in older:
                bar.status = "finalized"
            candle = bars.get(minute)
            corrected = False
            if candle is None:
                candle = Candle(time=minute, open=tick.price, high=tick.price, low=tick.price,
                                close=tick.price, event_count=1, last_event_time=epoch_ms,
                                _open_order=order, _close_order=order)
                if tick.timestamp_source != "exchange":
                    candle.quality_flags.append("receipt_timestamp_fallback")
                bars[minute] = candle
                bars = OrderedDict(sorted(bars.items()))
                self._candles[key] = bars
            else:
                candle.high = max(candle.high, tick.price)
                candle.low = min(candle.low, tick.price)
                candle.event_count += 1
                candle.last_event_time = max(candle.last_event_time, epoch_ms)
                if order < candle._open_order:
                    candle.open, candle._open_order = tick.price, order
                    corrected = True
                if order >= candle._close_order:
                    candle.close, candle._close_order = tick.price, order
                if candle.status != "provisional":
                    candle.status = "reconciled"
                    candle.source = "websocket-reconciled"
                    if "late_event" not in candle.quality_flags:
                        candle.quality_flags.append("late_event")
                    corrected = True
            while len(bars) > self.max_candles:
                bars.popitem(last=False)
            return candle, older, corrected

    def merge_historical(self, key: str, rows: list[dict[str, Any]]) -> tuple[list[Candle], int]:
        """Merge authoritative completed history, preserving a current provisional bar."""
        accepted: list[Candle] = []
        rejected = 0
        with self._lock:
            bars = self._candles.setdefault(key, OrderedDict())
            for row in rows:
                try:
                    ts = parse_candle_time(row["time"])
                    start = ts // 60 * 60
                    o, h, low, c = (float(row[k]) for k in ("open", "high", "low", "close"))
                    if not all(math.isfinite(v) and v > 0 for v in (o, h, low, c)) or low > min(o, c) or h < max(o, c) or low > h:
                        raise ValueError("invalid OHLC")
                except (KeyError, TypeError, ValueError, OverflowError, OSError):
                    rejected += 1
                    continue
                existing = bars.get(start)
                if existing and existing.status == "provisional" and start >= int(time.time() // 60 * 60):
                    continue
                candle = Candle(time=start, open=o, high=h, low=low, close=c,
                                volume=row.get("volume"), status="reconciled", source="historical-api",
                                event_count=int(row.get("event_count", 0)))
                bars[start] = candle
                accepted.append(candle)
            self._candles[key] = OrderedDict(sorted(bars.items()))
            while len(self._candles[key]) > self.max_candles:
                self._candles[key].popitem(last=False)
        return accepted, rejected

    def candles(self, key: str, start: int | None = None, end: int | None = None) -> list[Candle]:
        with self._lock:
            bars = self._candles.get(key, {})
            return [bar for t, bar in bars.items() if (start is None or t >= start) and (end is None or t <= end)]


class CandleRepository:
    """SQLite store for validated instrument metadata and completed/provisional candles."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self._lock = threading.RLock()
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS instruments (
                instrument_key TEXT PRIMARY KEY, exchange_type INTEGER NOT NULL,
                token TEXT NOT NULL, symbol TEXT, underlying TEXT, expiry TEXT,
                strike REAL, option_type TEXT, lot_size INTEGER, tick_size REAL,
                updated_at_utc INTEGER NOT NULL, metadata_json TEXT NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS candles (
                instrument_key TEXT NOT NULL, timeframe TEXT NOT NULL,
                candle_start_utc INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
                low REAL NOT NULL, close REAL NOT NULL, volume INTEGER,
                status TEXT NOT NULL, source TEXT NOT NULL, event_count INTEGER NOT NULL,
                last_event_time_utc INTEGER NOT NULL, quality_flags TEXT NOT NULL,
                updated_at_utc INTEGER NOT NULL,
                PRIMARY KEY(instrument_key,timeframe,candle_start_utc))""")
            db.execute("CREATE INDEX IF NOT EXISTS candles_range ON candles(instrument_key,timeframe,candle_start_utc)")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def upsert_instrument(self, metadata: dict[str, Any]):
        key = f"{int(metadata['exchangeType'])}:{str(metadata['token'])}"
        now = int(datetime.now(UTC).timestamp())
        with self._lock, closing(self._connect()) as db, db:
            db.execute("""INSERT INTO instruments VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(instrument_key) DO UPDATE SET symbol=excluded.symbol,
                underlying=excluded.underlying,expiry=excluded.expiry,strike=excluded.strike,
                option_type=excluded.option_type,lot_size=excluded.lot_size,tick_size=excluded.tick_size,
                updated_at_utc=excluded.updated_at_utc,metadata_json=excluded.metadata_json""",
                (key, int(metadata["exchangeType"]), str(metadata["token"]), metadata.get("symbol"),
                 metadata.get("underlying"), metadata.get("expiry"), metadata.get("strike"),
                 metadata.get("side"), metadata.get("lotSize"), metadata.get("tickSize"), now,
                 json.dumps(metadata, separators=(",", ":"))))

    def upsert_candle(self, key: str, candle: Candle, timeframe: str = TIMEFRAME):
        now = int(datetime.now(UTC).timestamp())
        with self._lock, closing(self._connect()) as db, db:
            old = db.execute("SELECT source,status FROM candles WHERE instrument_key=? AND timeframe=? AND candle_start_utc=?",
                             (key, timeframe, candle.time)).fetchone()
            # Do not let a provisional socket bar overwrite a trusted completed historical bar.
            if old and old["source"] == "historical-api" and candle.source != "historical-api":
                return
            db.execute("""INSERT INTO candles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(instrument_key,timeframe,candle_start_utc) DO UPDATE SET
                open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
                volume=COALESCE(excluded.volume,candles.volume),status=excluded.status,
                source=excluded.source,event_count=excluded.event_count,
                last_event_time_utc=excluded.last_event_time_utc,quality_flags=excluded.quality_flags,
                updated_at_utc=excluded.updated_at_utc""",
                (key, timeframe, candle.time, candle.open, candle.high, candle.low, candle.close,
                 candle.volume, candle.status, candle.source, candle.event_count, candle.last_event_time,
                 json.dumps(candle.quality_flags), now))

    def get_candles(self, key: str, start: int | None = None, end: int | None = None,
                    limit: int = 3000, timeframe: str = TIMEFRAME):
        sql = "SELECT * FROM candles WHERE instrument_key=? AND timeframe=?"
        args: list[Any] = [key, timeframe]
        if start is not None:
            sql += " AND candle_start_utc>=?"; args.append(start)
        if end is not None:
            sql += " AND candle_start_utc<=?"; args.append(end)
        sql += " ORDER BY candle_start_utc DESC LIMIT ?"; args.append(max(1, min(10000, int(limit))))
        with self._lock, closing(self._connect()) as db, db:
            rows = db.execute(sql, args).fetchall()
        result = [dict(row) for row in reversed(rows)]
        for row in result:
            row["time"] = row.pop("candle_start_utc")
            row["quality_flags"] = json.loads(row["quality_flags"] or "[]")
        return result

    def latest_time(self, key: str, timeframe: str = TIMEFRAME) -> int | None:
        with self._lock, closing(self._connect()) as db, db:
            row = db.execute("SELECT MAX(candle_start_utc) FROM candles WHERE instrument_key=? AND timeframe=?",
                             (key, timeframe)).fetchone()
        return row[0] if row and row[0] is not None else None


class MarketDataEngine:
    """Broker-independent aggregation and persistence orchestration."""

    def __init__(self, repository: CandleRepository):
        self.repository = repository
        self.aggregator = CandleAggregator()
        self.last_persisted: dict[tuple[str, int], float] = {}
        self.last_persisted_lock = threading.Lock()

    def register(self, metadata: dict[str, Any]):
        if not metadata.get("token") or not metadata.get("exchangeType"):
            raise ValueError("Instrument token and exchange type are required for registry identity.")
        self.repository.upsert_instrument(metadata)

    def ingest(self, tick: NormalizedTick) -> dict[str, Any] | None:
        candle, finalized, corrected = self.aggregator.ingest(tick)
        if candle is None:
            return None
        now = time.monotonic()
        for closed in finalized:
            self.repository.upsert_candle(tick.instrument_key, closed)
        persist_key = (tick.instrument_key, candle.time)
        with self.last_persisted_lock:
            due = now - self.last_persisted.get(persist_key, 0.0) >= 1.0
            if due or finalized or corrected:
                self.repository.upsert_candle(tick.instrument_key, candle)
                self.last_persisted[persist_key] = now
        return {"instrument_key": tick.instrument_key, "timeframe": TIMEFRAME,
                "candle": candle.public(), "status": candle.status,
                "corrected": corrected, "finalized": [bar.public() for bar in finalized]}

    def reconcile(self, exchange_type: int, token: str, rows: list[dict[str, Any]],
                  timeframe: str = TIMEFRAME) -> dict[str, Any]:
        key = f"{int(exchange_type)}:{str(token)}"
        if timeframe == TIMEFRAME:
            accepted, rejected = self.aggregator.merge_historical(key, rows)
        else:
            accepted, rejected = [], 0
            for row in rows:
                try:
                    stamp = parse_candle_time(row["time"])
                    o, h, low, c = (float(row[k]) for k in ("open", "high", "low", "close"))
                    if (not all(math.isfinite(v) and v > 0 for v in (o, h, low, c))
                            or low > min(o, c) or h < max(o, c) or low > h):
                        raise ValueError("invalid OHLC")
                    accepted.append(Candle(stamp, o, h, low, c, row.get("volume"),
                                           "reconciled", "historical-api",
                                           int(row.get("event_count", 0))))
                except (KeyError, TypeError, ValueError, OverflowError, OSError):
                    rejected += 1
        for candle in accepted:
            self.repository.upsert_candle(key, candle, timeframe)
        return {"accepted": len(accepted), "rejected": rejected, "corrected": len(accepted)}

