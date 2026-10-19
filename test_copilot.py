import json
import unittest
from io import BytesIO
from urllib.error import URLError
from unittest.mock import patch

import server


class LocalCopilotTests(unittest.TestCase):
    def test_status_reports_installed_gemma_3_1b(self):
        response = BytesIO(json.dumps({"models": [{"name": "gemma3:1b"}]}).encode())
        with patch.object(server, "urlopen", return_value=response):
            status = server.ollama_status()
        self.assertTrue(status["available"])
        self.assertEqual(status["model"], "gemma3:1b")

    def test_status_reports_ollama_offline_without_raising(self):
        with patch.object(server, "urlopen", side_effect=URLError("offline")):
            status = server.ollama_status()
        self.assertFalse(status["available"])
        self.assertFalse(status["running"])
        self.assertIn("rule-based", status["message"])

    def test_context_is_allowlisted_and_excludes_authentication(self):
        paper = {"state": "OPEN", "symbol": "NIFTY CE", "lots": 1, "units": 65,
                 "entryPrice": 100, "stopPrice": 96, "targetPrice": 112.5,
                 "token": "instrument-token", "apiKey": "secret-api-key",
                 "jwtToken": "secret-session"}
        with patch.object(server.S, "paper", paper), \
                patch.object(server.S, "quotes", {"instrument-token": {"ltp": 101,
                                                                          "jwtToken": "secret-quote"}}), \
                patch.object(server.S, "feed_connected", True):
            context = server.copilot_context("position")
        serialized = json.dumps(context)
        self.assertIn('"latest_option_ltp": 101', serialized)
        self.assertNotIn("secret-api-key", serialized)
        self.assertNotIn("secret-session", serialized)
        self.assertNotIn("secret-quote", serialized)

    def test_generation_sends_only_local_allowlisted_summary_data(self):
        position = {"state": "OPEN", "symbol": "SENSEX PE", "lots": 1, "units": 30,
                    "entryPrice": 200, "stopPrice": 196, "targetPrice": 212.5,
                    "token": "instrument-token"}
        response = BytesIO(json.dumps({"response": "A paper position is open."}).encode())
        with patch.object(server.S, "paper", position), \
                patch.object(server.S, "quotes", {"instrument-token": {"ltp": 201}}), \
                patch.object(server.S, "feed_connected", True), \
                patch.object(server.S, "api_key", "must-not-send"), \
                patch.object(server.S, "client_code", "must-not-send"), \
                patch.object(server, "urlopen", return_value=response) as mocked_urlopen:
            answer = server.generate_local_copilot_brief("position")
        request = mocked_urlopen.call_args.args[0]
        body = json.loads(request.data.decode())
        self.assertEqual(answer, "A paper position is open.")
        self.assertEqual(body["model"], "gemma3:1b")
        self.assertIn("SENSEX PE", body["prompt"])
        self.assertNotIn("must-not-send", body["prompt"])


if __name__ == "__main__":
    unittest.main()
