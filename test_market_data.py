import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from market_data import (CandleRepository, MarketDataEngine, NormalizedTick,
                         parse_candle_time, parse_event_time)


UTC = timezone.utc


def tick(token="101", price=100.0, stamp="2026-10-17T03:45:01+00:00", seq=None, exchange=2):
    return NormalizedTick(exchange, token, price, datetime.fromisoformat(stamp),
                          sequence_number=seq)


class CandleEngineTests(unittest.TestCase):
    def test_open_high_low_close_with_multiple_ticks_in_minute(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            for price, second in [(100, 1), (103.5, 12), (99.5, 37), (102, 59)]:
                event = tick(price=price, stamp=f"2026-10-17T03:45:{second:02d}+00:00", seq=second)
                bar = engine.ingest(event)["candle"]
            self.assertEqual((bar["open"], bar["high"], bar["low"], bar["close"]),
                             (100, 103.5, 99.5, 102))
            self.assertEqual(bar["event_count"], 4)
            self.assertIsNone(bar["volume"])

    def test_exact_minute_boundary_finalizes_previous_and_starts_new(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            first = engine.ingest(tick(stamp="2026-10-17T03:45:59+00:00", seq=1))
            second = engine.ingest(tick(price=101, stamp="2026-10-17T03:46:00+00:00", seq=2))
            self.assertEqual(first["candle"]["status"], "provisional")
            self.assertEqual(second["finalized"][0]["status"], "finalized")
            self.assertEqual(second["candle"]["time"] - first["candle"]["time"], 60)

    def test_missing_minutes_are_not_fabricated(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            engine.ingest(tick(stamp="2026-10-17T03:45:01+00:00", seq=1))
            engine.ingest(tick(stamp="2026-10-17T03:48:01+00:00", seq=2))
            rows = engine.aggregator.candles("2:101")
            self.assertEqual([c.time for c in rows], [1792208700, 1792208880])

    def test_duplicate_sequence_is_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            engine.ingest(tick(price=100, seq=44))
            self.assertIsNone(engine.ingest(tick(price=999, seq=44)))
            self.assertEqual(engine.aggregator.candles("2:101")[0].high, 100)

    def test_out_of_order_events_reconcile_open_and_latest_close(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            engine.ingest(tick(price=102, stamp="2026-10-17T03:45:40+00:00", seq=20))
            update = engine.ingest(tick(price=100, stamp="2026-10-17T03:45:10+00:00", seq=10))
            bar = update["candle"]
            self.assertEqual((bar["open"], bar["close"], bar["high"]), (100, 102, 102))
            self.assertTrue(update["corrected"])

    def test_independent_instruments_use_exchange_and_token_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            engine.ingest(tick(token="101", price=100, seq=1, exchange=2))
            engine.ingest(tick(token="101", price=200, seq=1, exchange=4))
            self.assertEqual(engine.aggregator.candles("2:101")[0].close, 100)
            self.assertEqual(engine.aggregator.candles("4:101")[0].close, 200)

    def test_invalid_prices_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            self.assertIsNone(engine.ingest(tick(price=float("nan"), seq=1)))
            self.assertIsNone(engine.ingest(tick(price=0, seq=2)))
            self.assertEqual(engine.aggregator.candles("2:101"), [])

    def test_exchange_millisecond_timestamp_and_receipt_fallback(self):
        parsed, source = parse_event_time(1792212300123)
        self.assertEqual(source, "exchange")
        self.assertEqual(parsed, datetime.fromtimestamp(1792212300.123, UTC))
        receipt = datetime(2026, 10, 17, tzinfo=UTC)
        parsed, source = parse_event_time(0, receipt)
        self.assertEqual(source, "receipt_fallback")
        self.assertEqual(parsed, receipt)

    def test_historical_reconciliation_persists_and_corrects_completed_bar(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = CandleRepository(Path(folder) / "candles.sqlite3")
            engine = MarketDataEngine(repo)
            engine.ingest(tick(price=100, stamp="2026-10-17T03:45:10+00:00", seq=1))
            result = engine.reconcile(2, "101", [{"time": "2026-10-17T09:15:00+05:30",
                "open": 99, "high": 105, "low": 98, "close": 103, "volume": 500}], "1m")
            self.assertEqual(result["accepted"], 1)
            rows = repo.get_candles("2:101", timeframe="1m")
            self.assertEqual((rows[0]["open"], rows[0]["close"], rows[0]["source"]),
                             (99, 103, "historical-api"))

    def test_candle_time_naive_broker_string_is_exchange_local(self):
        self.assertEqual(parse_candle_time("2026-10-17T09:15:00"),
                         int(datetime(2026, 10, 17, 3, 45, tzinfo=UTC).timestamp()))

    def test_three_minute_nse_open_replay_for_two_option_strikes(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = MarketDataEngine(CandleRepository(Path(folder) / "candles.sqlite3"))
            fixture = [
                ("101", 100.0, "03:45:01", 1), ("102", 200.0, "03:45:02", 1),
                ("101", 102.0, "03:45:50", 2), ("102", 199.0, "03:45:55", 2),
                ("101", 103.0, "03:46:00", 3), ("102", 201.0, "03:46:01", 3),
                ("101", 101.0, "03:47:15", 4), ("102", 202.0, "03:47:20", 4),
                ("101", 104.0, "03:47:59", 5), ("102", 198.0, "03:47:59", 5),
            ]
            for token, price, clock, seq in fixture:
                engine.ingest(tick(token=token, price=price,
                    stamp=f"2026-10-17T{clock}+00:00", seq=seq))
            ce = engine.aggregator.candles("2:101")
            pe = engine.aggregator.candles("2:102")
            self.assertEqual(len(ce), 3)
            self.assertEqual(len(pe), 3)
            self.assertEqual([(c.open, c.high, c.low, c.close) for c in ce],
                [(100, 102, 100, 102), (103, 103, 103, 103), (101, 104, 101, 104)])
            self.assertEqual([(c.open, c.high, c.low, c.close) for c in pe],
                [(200, 200, 199, 199), (201, 201, 201, 201), (202, 202, 198, 198)])


if __name__ == "__main__":
    unittest.main()
