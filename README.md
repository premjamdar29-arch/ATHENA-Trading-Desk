# ATHENA + Angel One Internal Paper Desk

This prototype reads Angel One SmartAPI market data and simulates paper trades locally. News and automatic ATHENA scoring are removed; the user selects the ATHENA direction (CE/PE), underlying, and ATM strike. One lot is 65 units for NIFTY 50 or 30 for SENSEX; the selected contract's instrument-master lot size is checked before paper simulation. Paper entries are blocked on Saturday and Sunday and outside the weekday 09:15–09:16 IST entry window. Orders & Positions shows open positions and closed positions for the current IST date; closed positions disappear from that tab after the IST date changes, while the journal retains its records. Scheduled entries are listed in Strategy & Risk and can be cancelled while pending. Paper position risk distances are fixed at +12.5 option-premium points TP and −4.0 points initial SL.

## Install and run (Windows PowerShell)

Use Python 3.9 or newer. From this folder:

```powershell
python -m pip install -r requirements.txt
python .\server.py
```

Open `http://127.0.0.1:8765` and keep the server window running. For the first sign-in, enter your SmartAPI key, Angel One client code, PIN, and current TOTP. After a successful sign-in, the API key and client code are encrypted for your Windows user with DPAPI at `%LOCALAPPDATA%\ATHENA-PaperDesk\angel-credentials.dpapi`; they load automatically and their fields are hidden on later visits. Use **Forget saved IDs** to delete them and show the ID fields again. The Trading PIN, TOTP, and session tokens are never saved. Credentials are not written to browser storage. After updating ATHENA, close the old launcher/server and start the updated `AthenaPaperDesk.exe` so the new credential endpoint is loaded. SmartAPI's date-wise logs are redirected to `%LOCALAPPDATA%\ATHENA-PaperDesk\logs`; raw tick logging is suppressed by the app.

### Desktop launcher

Double-click `AthenaPaperDesk.exe` in this folder. It starts `server.py`, checks `/api/health` for up to 30 seconds, and opens the browser at `http://127.0.0.1:8765/`. Keep the launcher window open while using the desk. **Stop server and exit** sends a private loopback-only shutdown request to the server process this launcher started, waits up to five seconds, and force-stops only that owned process if it will not exit. A server that was already running is reused and is left running when the launcher closes. Opening the launcher a second time in the same Windows session does not create another copy. Python 3.9+ and the packages in `requirements.txt` must already be installed; the launcher does not install software. Startup output is written to `%LOCALAPPDATA%\ATHENA-PaperDesk\launcher.log`. The launcher checks the local Ollama API and starts `ollama.exe serve` hidden if it is not already running. It opens ATHENA when the desk server is ready and reports Ollama readiness or startup failures in its window and log. `gemma3:1b` must already be installed. When ATHENA closes, the launcher stops local `ollama.exe` processes too; this also disconnects any other local app using Ollama.

To rebuild the desktop launcher after changing `Launcher.cs`, open PowerShell in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build_launcher.ps1
```

This uses the Windows .NET Framework 4.x C# compiler and replaces `AthenaPaperDesk.exe`. Keep the EXE beside `server.py` and the rest of the app files.

## Live market charts

- The existing Python `ThreadingHTTPServer` and Angel One SmartAPI login are reused. The WebSocket callback places packets on a bounded queue; a worker validates them, normalizes exchange timestamps and prices, updates per-instrument candles, persists data, and publishes quote/candle updates to the existing browser SSE stream.
- One-minute candles are keyed by exchange type plus instrument token. Exchange event time is preferred; implausible or missing event timestamps use receipt time and are identified as a fallback. Duplicate sequence numbers are ignored, out-of-order events update the matching candle, and quiet intervals are left empty.
- SQLite stores instrument metadata and provisional/finalized/historical candle rows with source and quality metadata at `%LOCALAPPDATA%\ATHENA-PaperDesk\market-data.sqlite3`. Candles load after restart. Reconnect recovery requests recent one-minute candles, reconciles them with socket data, and is capped to the broker's recent-history window. Failed requests leave recovery marked degraded with unresolved instruments.
- The Live Markets chart uses the locally bundled, pinned TradingView Lightweight Charts 5.2.1 distribution (license included under `vendor`). Open any option from the chain, then use **Add to comparison** for more strikes (maximum 12 visible charts). Each panel has its own time scale, candles, crosshair OHLC, last price, freshness, fit, zoom, pan and remove controls. Wheel zoom and left-drag navigation are provided by the chart library.
- Selecting a timeframe or changing the date range automatically loads broker history for each open chart. Sub-minute charts use locally collected five-second bars, because the SmartAPI historical endpoint supplies one-minute candles and longer intervals. Other timeframes roll up source candles on the 09:15 IST session boundary; a daily candle uses the exchange-local session date.
- Backend diagnostics are available at `/api/market/status`, instrument registry at `/api/market/instruments`, and persisted candles at `/api/market/candles`. A quiet option is not declared disconnected just for not trading; the global feed is marked stale only when expected index updates stop during the trading session. A chart's last update time remains visible per instrument.
- No environment setup beyond the existing runtime and SmartAPI credentials entered into the local login form is required. The API key and client code are loaded from the current Windows user's DPAPI-protected file; enter the Trading PIN and a fresh TOTP for each login. Session tokens remain in memory and are discarded after restart.

## Paper simulation

- The app loads Angel One's instrument master to find the chosen NIFTY/SENSEX option contract and exchange lot size.
- SmartAPI WebSocket Snap Quote streaming supplies index and option LTP plus the option chain's best bid and ask. LTP changes when an option trade occurs; bid/ask may change with order-book updates. Neither is guaranteed to update on every underlying index tick, and the app does not fabricate an index-linked option premium.
- The option-chain panel shows both NIFTY 50 and SENSEX live spot prices as clickable index selectors. Spot prices remain visible for both indices; contract selection is made from the option chain.
- Expiry defaults to the nearest upcoming contract returned by Angel One's instrument master and is refreshed when the underlying changes. This uses the listed expiry date (including exchange holiday adjustments), rather than assuming a weekday.
- **Live option chain and charts:** after connecting, click the NIFTY 50 or SENSEX live spot card above the chain to select that index and automatically load its nearest listed expiry, centered on the latest spot. The desk subscribes to CE and PE contracts across 10 strikes on either side of ATM (up to 42 contracts), displays LTP and best bid/ask, and lets you click a premium to open or compare a chart. Candles persist in SQLite and chart history loads automatically for the selected date range and timeframe.
- **Start internal paper trade** records the latest option LTP as the simulated average entry and derives units from lots × exchange lot size. It does not send an Angel One order and does not model partial fills.
- **Schedule paper entry** accepts a one-time weekday `HH:MM:SS` time in the 09:15–09:16 IST entry window. Weekend dates and entries outside that window are rejected. At the scheduled time, it opens an internal paper position only if the selected contract is unchanged, the live feed is connected, and its option quote is no more than three seconds old. The scheduled fill uses that LTP and exits on the first received tick at/above +12.5 points or at/below −4.0 points, plus the existing 09:16 universal exit. The local server must remain running; a missed/stale quote fails the schedule instead of placing a late entry.
- **Paper balance and journal:** use Set balance for starting simulated capital or Add funds to increase it. Closed paper trades are added to the journal and their estimated net P&L is applied to the paper balance. Balance and the last 500 completed trades persist in `%LOCALAPPDATA%\ATHENA-PaperDesk\paper-ledger.json`; this is a manually maintained paper ledger, not Angel One's actual account balance. Open P&L is excluded from the balance.
- TP is entry +12.5 premium points and initial SL is entry −4.0 premium points, rounded to the option instrument's tick size. Rounded distances are validated. Risk and peak/floor profit are displayed in premium points and rupees using the simulated filled quantity. Planned initial risk over ₹300 is flagged; risk over ₹400 is rejected.
- The strategy defaults are centralized in `STRATEGY_CONFIG` in `server.py`: trailing enabled; target +12.5 points; initial stop −4 points; TP removal threshold +12.5 points; minimum estimated net open profit ₹500; maximum giveback 20%; preferred/absolute initial risk ₹300/₹400; confirmed momentum required; holding while momentum is strong allowed.
- On each option tick at/above the TP removal threshold, the paper engine evaluates all gates before its internal fixed-target exit: estimated net open profit at least ₹500 and three consecutive rising option ticks. Only if every gate passes does it enter `TRAILING_ACTIVE` and mark the simulated TP removed. Otherwise the fixed TP exits the paper position at that tick. This is an atomic simulator decision, not a broker cancellation acknowledgement.
- Estimated net open profit is gross mark-to-entry P&L less `ESTIMATED_ROUND_TRIP_COST_INR`, currently defaulted to ₹0 because this prototype does not fetch or calculate brokerage, taxes, or other fees. Configure a realistic estimate before relying on the ₹500 gate. A 30-unit SENSEX lot makes ₹375 gross at +12.5 points, so it will take the fixed TP unless a price gap produces enough open profit at the evaluation tick.
- After trailing activates, the stop protects 80% of the highest favorable premium movement. It can only rise. No separate structural trailing stop is currently generated, so the 80% floor is the active trailing reference.
- A local clock closes an open simulated position at/after 09:16 Asia/Kolkata using the latest received quote. If the feed disconnects, automatic simulation cannot guarantee an exit until it resumes. Manual close uses the latest quote.
- Gross and estimated net paper P&L are shown; brokerage, taxes, slippage, queue position, partial fills and market impact are not modeled unless a fee estimate is configured. LTP is a simplified fill model and is not an executable bid/ask price.
- Open positions, PIN/TOTP values, session tokens, ticks, and pending schedules are held in memory. The API key and client code are kept in the current Windows user's DPAPI-protected credential file. Restarting the local server clears active session state; the configured paper balance and completed journal remain in the local ledger file.

## Security and boundaries

The local server binds only to `127.0.0.1`, does not expose credential fields through browser storage, and avoids logging request bodies. The saved API key and client code can be decrypted only under the same Windows user account. Use this only on a trusted computer. Do not send API keys, PINs, or TOTP secrets in chat or commit them to source control.

No broker order-placement, modification, or cancellation endpoint is implemented. TP cancellation and stop transitions are internal paper-state changes only; this prototype does not verify broker acknowledgements and must not be used for live orders. A compatible live design would need broker-supported bracket/OCO order transitions, confirmation that the TP cancel/change succeeded while the protective SL remains active, and reconciliation against broker order/trade updates for fills, partial fills, rejects, gaps, and disconnect recovery. Since none of these components exists here, live trailing is intentionally not enabled. Live trading, exchange approval/registration, broker policy requirements, and production-grade failover/risk controls are outside this paper-only prototype. The market feed and this desktop process cannot guarantee 95–100 ms end-to-end execution latency.

## Paper-risk tests

Run the deterministic checks from this folder:

```powershell
python -m unittest -v test_market_catalog test_market_data test_market_api test_paper_risk test_copilot
node --test test_chart_manager.cjs
```

They cover the Angel One instrument catalog and supported segment mappings, Copilot privacy boundaries, candle timestamps, independent option streams, replayed NSE session candles, SQLite reconciliation, market API/static asset serving, chart history/live updates/corrections, multi-panel lifecycle, paper TP/SL behavior, and the absence of broker order calls. The tests use synthetic data and do not log in to SmartAPI.

## ATHENA workspace structure

The desktop workspace is organized as: **God’s View**, **Markets & Watchlist**, **Charts & Order Flow**, **Strategy & Risk**, **Trading Desk**, **Journal & Analytics**, **AI Copilot**, and **Settings & System**. Markets & Watchlist searches Angel One’s current scrip master for NSE/BSE cash stocks and NSE/BSE F&O contracts only; expired contracts and explicit broker test scrips are excluded. BSE debt-like codes are categorized as other and excluded. Empty searches show stocks first. The list can save up to 300 supported instruments locally. Search ignores spaces and punctuation (for example, `Tata Motors` can match `TATAMOTORS-EQ`); stock rows show the master’s stock name and retain the exact exchange symbol/token for quotes. Live quotes are subscribed within SmartAPI WebSocket V2 limits. The scanner ranks only active-chain options when the feed provides a previous-close reference. Copilot can use the optional local Ollama model and keeps its rule-based fallback.

Global news/event ingestion, a full NSE cash-stock scanner and breadth/sector rotation require additional data providers and subscription coverage. The Copilot can use optional local Ollama inference; custom Python indicators still require an isolated execution environment. Order-flow views are limited to data supplied by Angel One (including its current depth snapshots); they do not reconstruct historical aggressor-side footprint data. The Trading Desk remains paper-only and does not submit live broker orders.

### Local AI Copilot (optional)

ATHENA can use Ollama running on this PC with the `gemma3:1b` model. Install [Ollama for Windows](https://ollama.com/download/windows), open Ollama, then run this once in PowerShell:

```powershell
ollama pull gemma3:1b
```

Restart the ATHENA launcher and open **AI Copilot**. The status label reports whether Ollama and the model are ready. If Ollama is stopped or the model is missing, the existing local rule-based summary still works and the Copilot displays the setup issue. The desktop launcher starts Ollama in the background when needed and stops its local server process when ATHENA closes. The local endpoint is `127.0.0.1:11434`; the app sends only the selected summary topic and a small allow-listed paper position/feed snapshot. Angel One API keys, client code, PIN, TOTP, and session tokens are excluded. The model is for status explanations only; it cannot place or manage orders.

The configured generation uses a 2,048-token context, up to 220 output tokens, and a 60-second request timeout. On a 4 GB laptop GPU, Gemma 3 1B is the intended starting point; actual speed depends on Ollama's hardware detection and available memory.
