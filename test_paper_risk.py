import unittest
from datetime import date, datetime, time

import server


def position(entry=100.0, units=50, tick=0.05):
    target, stop, reward, risk = server.initial_levels(entry, tick)
    return {
        "state": "OPEN", "entryPrice": entry, "averageEntryPrice": entry,
        "lastPrice": entry, "peakPrice": entry, "peakPoints": 0.0,
        "units": units, "tickSize": tick, "targetPrice": target,
        "initialStopPrice": stop, "stopPrice": stop,
        "targetPoints": server.FIXED_TP_POINTS,
        "initialRiskPoints": server.INITIAL_SL_POINTS,
        "roundedRewardPoints": reward, "roundedRiskPoints": risk,
        "trailingState": "FIXED", "tpState": "ACTIVE",
        "profitFloorPoints": 0.0, "structuralStopPrice": None,
        "recentPrices": [],
    }


class PaperRiskTests(unittest.TestCase):
    def test_lot_size_and_units_follow_selected_underlying(self):
        self.assertEqual(server.lot_size_for("NIFTY"), 65)
        self.assertEqual(server.lot_size_for("SENSEX"), 30)
        self.assertEqual(server.quantity_for_lots("NIFTY", 2), 130)
        self.assertEqual(server.quantity_for_lots("SENSEX", 2), 60)

    def test_entries_are_limited_to_weekday_opening_window(self):
        monday_open = datetime(2026, 10, 19, 9, 15, 30, tzinfo=server.IST)
        server.require_paper_entry_session(monday_open)
        for closed_time in (
            datetime(2026, 10, 18, 9, 15, 30, tzinfo=server.IST),
            datetime(2026, 10, 17, 9, 15, 30, tzinfo=server.IST),
            datetime(2026, 10, 19, 9, 14, 59, tzinfo=server.IST),
            datetime(2026, 10, 19, 9, 16, 0, tzinfo=server.IST),
        ):
            with self.assertRaises(RuntimeError):
                server.require_paper_entry_session(closed_time)

    def test_scheduled_entries_reject_weekends_and_out_of_window_times(self):
        server.validate_scheduled_entry_time(date(2026, 10, 19), time(9, 15))
        for entry_date, entry_time in (
            (date(2026, 10, 17), time(9, 15)),
            (date(2026, 10, 18), time(9, 15)),
            (date(2026, 10, 19), time(9, 14, 59)),
            (date(2026, 10, 19), time(9, 16)),
        ):
            with self.assertRaises(ValueError):
                server.validate_scheduled_entry_time(entry_date, entry_time)

    def test_closed_positions_are_visible_only_for_the_ist_day(self):
        trades = [
            {"symbol": "TODAY", "closedAt": "2026-10-19T09:16:00+05:30"},
            {"symbol": "YESTERDAY", "closedAt": "2026-10-18T09:16:00+05:30"},
        ]
        self.assertEqual([trade["symbol"] for trade in server.closed_paper_positions_for_day(
            trades, date(2026, 10, 19))], ["TODAY"])

    def test_strategy_configuration_uses_requested_defaults(self):
        expected = {
            "SMART_SL_TRAILING_ENABLED": True,
            "INITIAL_TP_POINTS": 12.5,
            "INITIAL_SL_POINTS": 4.0,
            "TP_REMOVAL_TRIGGER_POINTS": 12.5,
            "TP_REMOVAL_MIN_OPEN_PROFIT_INR": 500.0,
            "MAX_PEAK_PROFIT_GIVEBACK_PERCENT": 0.20,
            "PREFERRED_INITIAL_RISK_INR": 300.0,
            "ABSOLUTE_PLANNED_RISK_LIMIT_INR": 400.0,
            "REQUIRE_CONFIRMED_MOMENTUM": True,
            "ALLOW_HOLD_WHILE_MOMENTUM_STRONG": True,
        }
        for key, value in expected.items():
            self.assertEqual(server.STRATEGY_CONFIG[key], value)

    def test_fixed_tp_and_initial_sl_use_requested_premium_points(self):
        p = position()
        self.assertEqual(p["targetPrice"], 112.5)
        self.assertEqual(p["initialStopPrice"], 96.0)
        self.assertEqual(p["roundedRewardPoints"], 12.5)
        self.assertEqual(p["roundedRiskPoints"], 4.0)

    def test_levels_round_to_master_tick_and_validate_rounded_distances(self):
        self.assertEqual(server.tick_size_from_master("5"), 0.05)
        target, stop, reward, risk = server.initial_levels(100.03, 0.05)
        self.assertEqual(target, 112.55)
        self.assertEqual(stop, 96.05)
        self.assertGreaterEqual(reward, 12.5)
        self.assertLessEqual(risk, 4.0)
        with self.assertRaises(ValueError):
            server.initial_levels(2.0, 0.05)

    def test_fixed_tp_is_removed_only_at_threshold_with_confirmed_momentum(self):
        p = position()
        self.assertIsNone(server.update_paper_tick(p, 108.0))
        self.assertIsNone(server.update_paper_tick(p, 111.0))
        self.assertEqual(p["trailingState"], "FIXED")
        self.assertEqual(p["tpState"], "ACTIVE")
        self.assertIsNone(server.update_paper_tick(p, 112.5))
        self.assertEqual(p["trailingState"], "TRAILING_ACTIVE")
        self.assertEqual(p["tpState"], "CANCELLED_SIMULATED_AFTER_ALL_GATES")
        self.assertGreaterEqual(p["estimatedNetOpenProfitINR"], 500.0)

    def test_minimum_net_profit_gate_keeps_fixed_tp_when_not_met(self):
        p = position(units=65)
        p["estimatedRoundTripCostsINR"] = 400.0
        for price in (108.0, 111.0):
            self.assertIsNone(server.update_paper_tick(p, price))
        self.assertEqual(server.update_paper_tick(p, 112.5), "TAKE_PROFIT")
        self.assertEqual(p["estimatedNetOpenProfitINR"], 412.5)
        self.assertEqual(p["trailingState"], "FIXED")

    def test_sensex_single_lot_does_not_meet_minimum_rupee_gate_at_target(self):
        p = position(units=server.lot_size_for("SENSEX"))
        for price in (108.0, 111.0):
            self.assertIsNone(server.update_paper_tick(p, price))
        self.assertEqual(server.update_paper_tick(p, 112.5), "TAKE_PROFIT")
        self.assertEqual(p["estimatedNetOpenProfitINR"], 375.0)
        self.assertEqual(p["trailingState"], "FIXED")

    def test_planned_risk_preferred_and_absolute_limits(self):
        self.assertEqual(server.planned_risk_inr(4.0, 65), 260.0)
        self.assertEqual(server.planned_risk_inr(4.0, 100), 400.0)
        with self.assertRaisesRegex(ValueError, "absolute limit"):
            server.planned_risk_inr(4.0, 101)

    def test_single_threshold_tick_does_not_remove_fixed_tp(self):
        p = position()
        self.assertEqual(server.update_paper_tick(p, 112.5), "TAKE_PROFIT")
        self.assertEqual(p["trailingState"], "FIXED")
        self.assertEqual(p["tpState"], "ACTIVE")

    def test_trailing_floor_protects_80_percent_of_peak_and_stop_never_moves_back(self):
        p = position()
        for price in (108.0, 111.0, 112.5):
            server.update_paper_tick(p, price)
        server.update_paper_tick(p, 120.0)
        protected = p["stopPrice"]
        self.assertEqual(p["peakPoints"], 20.0)
        self.assertEqual(p["profitFloorPoints"], 16.0)
        self.assertEqual(protected, 116.0)
        for price in (118.0, 119.0, 117.0):
            self.assertIsNone(server.update_paper_tick(p, price))
            self.assertGreaterEqual(p["stopPrice"], protected)
        self.assertEqual(server.update_paper_tick(p, 116.0), "TRAILING_STOP")

    def test_realized_paper_pnl_uses_entry_and_actual_units(self):
        original = server.S.paper
        try:
            p = position(entry=100.0, units=75)
            p["token"] = "test"
            server.S.paper = p
            server.close_paper(112.5, "TAKE_PROFIT")
            self.assertEqual(server.S.paper["grossPnlPoints"], 12.5)
            self.assertEqual(server.S.paper["grossPnl"], 937.5)
            self.assertEqual(server.S.paper["estimatedNetPnlINR"], 937.5)
        finally:
            server.S.paper = original

    def test_paper_only_server_has_no_broker_order_calls(self):
        with open(server.__file__, encoding="utf-8") as source_file:
            source = source_file.read()
        self.assertNotIn(".placeOrder(", source)
        self.assertNotIn(".modifyOrder(", source)
        self.assertNotIn(".cancelOrder(", source)


if __name__ == "__main__":
    unittest.main()
