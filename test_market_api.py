import json
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class MarketApiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def test_market_status_exposes_health_and_subscription_counters(self):
        with urlopen(self.base + "/api/market/status", timeout=3) as response:
            status = json.load(response)
        self.assertIn("connectionState", status)
        self.assertIn("queueDepth", status)
        self.assertIn("subscriptionErrors", status)
        self.assertEqual(status["maxVisibleCharts"], 12)

    def test_market_search_finds_compact_angel_one_symbols_from_spaced_names(self):
        item = {"kind": "market", "category": "stock", "symbol": "TATAMOTORS-EQ",
                "name": "TATAMOTORS", "exchange": "NSE", "instrumentType": "EQ",
                "expiry": "", "token": "3456", "exchangeType": 1,
                "liveSupported": True, "marketKey": "NSE:3456"}
        with patch.object(server, "instrument_master_index", return_value={"search": [item]}):
            with urlopen(self.base + "/api/market/search?q=Tata%20Motors&category=stock&exchange=NSE", timeout=3) as response:
                body = json.load(response)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["instruments"][0]["symbol"], "TATAMOTORS-EQ")

    def test_launcher_health_endpoint_is_ready_without_authentication(self):
        with urlopen(self.base + "/api/health", timeout=3) as response:
            body = json.load(response)
        self.assertEqual(body, {"ok": True, "service": "athena-paper-desk"})

    def test_launcher_shutdown_requires_private_token(self):
        request = Request(self.base + "/api/launcher/shutdown", data=b"", method="POST")
        with self.assertRaises(HTTPError) as raised:
            urlopen(request, timeout=3)
        self.assertEqual(raised.exception.code, 403)

    def test_launcher_shutdown_with_token_stops_only_requested_server(self):
        previous_token = server.LAUNCHER_SHUTDOWN_TOKEN
        server.LAUNCHER_SHUTDOWN_TOKEN = "unit-test-token"
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(
                f"http://127.0.0.1:{httpd.server_address[1]}/api/launcher/shutdown",
                data=b"",
                headers={"X-Athena-Launcher-Token": "unit-test-token"},
                method="POST",
            )
            with urlopen(request, timeout=3) as response:
                self.assertEqual(json.load(response), {"ok": True})
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
        finally:
            server.LAUNCHER_SHUTDOWN_TOKEN = previous_token
            if thread.is_alive():
                httpd.shutdown()
            httpd.server_close()

    def test_saved_angel_credentials_are_encrypted_and_forgettable(self):
        with TemporaryDirectory() as directory:
            credential_file = Path(directory) / "credentials.dpapi"
            with patch.object(server, "SAVED_CREDENTIALS_PATH", credential_file):
                request = Request(
                    self.base + "/api/angel/credentials",
                    data=json.dumps({"apiKey": "test-api-key", "clientCode": "test-client",
                                     "pin": "never-store-pin", "totp": "123456"}).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request, timeout=3) as response:
                    self.assertEqual(json.load(response), {"saved": True})

                encrypted = credential_file.read_bytes()
                self.assertNotIn(b"test-api-key", encrypted)
                self.assertNotIn(b"test-client", encrypted)
                self.assertEqual(server.load_angel_credentials(),
                                 {"apiKey": "test-api-key", "clientCode": "test-client"})

                with urlopen(self.base + "/api/angel/credentials", timeout=3) as response:
                    self.assertEqual(json.load(response), {
                        "saved": True, "apiKey": "test-api-key", "clientCode": "test-client"
                    })
                request = Request(self.base + "/api/angel/credentials", method="DELETE")
                with urlopen(request, timeout=3) as response:
                    self.assertEqual(json.load(response), {"saved": False})
                self.assertIsNone(server.load_angel_credentials())

    def test_persisted_candle_route_returns_empty_for_unseen_instrument(self):
        with urlopen(self.base + "/api/market/candles?exchangeType=2&token=unseen&timeframe=1m", timeout=3) as response:
            body = json.load(response)
        self.assertEqual(body["instrumentKey"], "2:unseen")
        self.assertEqual(body["candles"], [])

    def test_chart_manager_asset_is_served_locally(self):
        with urlopen(self.base + "/chart_manager.js", timeout=3) as response:
            source = response.read().decode("utf-8")
        self.assertIn("AthenaChartManager", source)
        self.assertIn("series.update", source)


if __name__ == "__main__":
    unittest.main()
