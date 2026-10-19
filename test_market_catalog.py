import unittest
from datetime import date, timedelta
from unittest.mock import patch

import server


class AngelOneCatalogTests(unittest.TestCase):
    def test_instrument_search_normalization_ignores_spaces_and_punctuation(self):
        self.assertEqual(server.normalize_instrument_search("Tata Motors"), "tatamotors")
        self.assertEqual(server.normalize_instrument_search("TATA-MOTORS-EQ"), "tatamotorseq")
        item = {"symbol": "TATAMOTORS-EQ", "name": "TATAMOTORS", "exchange": "NSE",
                "instrumentType": "EQ", "expiry": ""}
        self.assertTrue(server.instrument_matches_search(item, "tatamotors"))

    def test_index_subscription_keys_use_the_stored_exchange_token_pairs(self):
        self.assertEqual(server.market_index_subscription_keys({"NIFTY": "99926000", "SENSEX": "99919000"}),
                         {"1:99926000", "3:99919000"})

    def test_market_watch_universe_is_cash_stocks_and_nse_bse_fno_only(self):
        def item(exchange, category):
            return {"exchange": exchange, "category": category}
        self.assertTrue(server.is_market_watchlist_in_scope(item("NSE", "stock")))
        self.assertTrue(server.is_market_watchlist_in_scope(item("BSE", "stock")))
        self.assertTrue(server.is_market_watchlist_in_scope(item("NFO", "future")))
        self.assertTrue(server.is_market_watchlist_in_scope(item("BFO", "option")))
        self.assertFalse(server.is_market_watchlist_in_scope(item("MCX", "commodity")))
        self.assertFalse(server.is_market_watchlist_in_scope(item("CDS", "currency")))
        self.assertFalse(server.is_market_watchlist_in_scope(item("NSE", "index")))

    def test_websocket_exchange_types_cover_documented_segments(self):
        self.assertEqual(server.exchange_type("NSE"), 1)
        self.assertEqual(server.exchange_type("NCDEX"), 7)
        self.assertEqual(server.exchange_type("CDS"), 13)
        self.assertEqual(server.exchange_type("NSEIX"), 0)
        self.assertEqual(server.historical_exchange(13), "CDS")
        self.assertIsNone(server.historical_exchange(7))

    def test_master_catalog_includes_stock_future_currency_and_commodity_rows(self):
        expiry = (date.today() + timedelta(days=30)).strftime("%d%b%Y").upper()
        rows = [
            {"name": "RELIANCE", "exch_seg": "NSE", "instrumenttype": "EQ",
             "symbol": "RELIANCE-EQ", "token": "100"},
            {"name": "NIFTY", "exch_seg": "NFO", "instrumenttype": "FUTIDX",
             "symbol": "NIFTY-FUT", "token": "200", "expiry": expiry, "lotsize": "65"},
            {"name": "USDINR", "exch_seg": "CDS", "instrumenttype": "FUTCUR",
             "symbol": "USDINR-FUT", "token": "300", "expiry": expiry},
            {"name": "GOLD", "exch_seg": "NCDEX", "instrumenttype": "FUTCOM",
             "symbol": "GOLD-FUT", "token": "400", "expiry": expiry},
        ]
        with patch.object(server.S, "master_index", None), patch.object(server, "load_master", return_value=rows):
            catalog = server.instrument_master_index()["search"]
        self.assertEqual({item["category"] for item in catalog}, {"stock", "future", "currency", "commodity"})
        support = {item["exchange"]: item["liveSupported"] for item in catalog}
        self.assertTrue(support["CDS"])
        self.assertTrue(support["NCDEX"])

    def test_catalog_excludes_test_scripts_and_does_not_label_bonds_as_stocks(self):
        rows = [
            {"name": "031NSETEST", "exch_seg": "NSE", "instrumenttype": "EQ",
             "symbol": "031NSETEST-EQ", "token": "1"},
            {"name": "03600AM27", "exch_seg": "BSE", "instrumenttype": "EQ",
             "symbol": "03600AM27", "token": "2"},
            {"name": "TCS", "exch_seg": "BSE", "instrumenttype": "EQ",
             "symbol": "500325", "token": "3"},
        ]
        with patch.object(server.S, "master_index", None), patch.object(server, "load_master", return_value=rows):
            catalog = server.instrument_master_index()["search"]
        self.assertEqual([(item["symbol"], item["category"]) for item in catalog],
                         [("500325", "stock"), ("03600AM27", "other")])


if __name__ == "__main__":
    unittest.main()
