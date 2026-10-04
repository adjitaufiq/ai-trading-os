"""Stage 3.0B-2B gateway safety scan: route inventory exact, no generic dispatch, no
execution/account/credential surface, loopback-only binding, native whitelist intact."""
import re
import unittest
from pathlib import Path

from mt5_bridge.native import NATIVE_WHITELIST
from mt5_gateway import service as svc_mod
from mt5_gateway.server import GatewayServer
from mt5_gateway.service import APPROVED_ROUTES, GatewayService

from test_safety import FORBIDDEN_MEMBERS, SECRET_INPUTS, code_tokens

GW = Path(__file__).resolve().parent.parent / "mt5_gateway"
FILES = sorted(GW.rglob("*.py"))


class GatewaySafety(unittest.TestCase):
    def test_files_found(self):
        self.assertEqual({f.name for f in FILES}, {"__init__.py", "clock.py", "envelope.py", "service.py", "server.py"})

    def test_route_inventory_exact(self):
        self.assertEqual(APPROVED_ROUTES, (
            ("GET", "/v1/health"), ("GET", "/v1/terminal"), ("GET", "/v1/symbols"), ("GET", "/v1/symbols/{symbol}"),
            ("GET", "/v1/ticks/latest/{symbol}"), ("GET", "/v1/ticks/{symbol}"),
            ("GET", "/v1/bars/{symbol}/{timeframe}"), ("WS", "/v1/stream")))

    def test_route_table_matches_inventory(self):
        src = (GW / "service.py").read_text(encoding="utf8")
        handlers = set(re.findall(r"self\.(_[a-z_]+), \(", src))
        self.assertEqual(handlers, {"_health", "_terminal", "_symbols", "_symbol_spec", "_latest_tick", "_ticks", "_bars"})

    def test_no_forbidden_members_anywhere(self):
        for f in FILES:
            self.assertIsNone(FORBIDDEN_MEMBERS.search(f.read_text(encoding="utf8")), f)

    def test_no_credential_surface(self):
        for f in FILES:
            self.assertIsNone(SECRET_INPUTS.search(code_tokens(f)), f)
            self.assertIsNone(re.search(r"\b(os\.environ|getenv|Authorization|token|account|server_name)\b",
                                        code_tokens(f)), f)

    def test_no_generic_rpc_or_dynamic_dispatch(self):
        for f in FILES:
            code = code_tokens(f)
            self.assertIsNone(re.search(r"\b(getattr|setattr|__getattribute__|importlib|eval|exec|globals|locals"
                                        r"|invoke|rpc|_native)\b", code), f)
            self.assertNotIn('" /invoke', code)

    def test_no_metatrader5_import_and_no_native_access(self):
        for f in FILES:
            t = f.read_text(encoding="utf8")
            self.assertIsNone(re.search(r"\bMetaTrader5\b|mt5_bridge\.native|WhitelistedNative", t), f)

    def test_no_wildcard_bind(self):
        for f in FILES:
            self.assertNotIn("0.0.0.0", f.read_text(encoding="utf8"))
        for host in ["0.0.0.0", "", "192.168.1.5", "::"]:
            with self.assertRaises(ValueError):
                GatewayServer(object(), host=host)  # type: ignore[arg-type]

    def test_no_operating_mode_mutation(self):
        for f in FILES:
            self.assertIsNone(re.search(r"\b(OPERATING_MODE|EXECUTION_ENABLED|DEMO)\b", code_tokens(f)), f)

    def test_source_mode_cannot_be_arbitrary(self):
        from mt5_gateway.clock import FakeTransportClock
        from mt5_gateway.envelope import EnvelopeFactory
        with self.assertRaises(ValueError):
            EnvelopeFactory(FakeTransportClock(0), "EXECUTION")  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            EnvelopeFactory(FakeTransportClock(0), "SIMULATION").build(
                request_id="x", capability="TRADE.SEND", delivery="LIVE", received_at=0)

    def test_service_requires_frozen_adapter(self):
        with self.assertRaises(TypeError):
            GatewayService(object(), None)  # type: ignore[arg-type]

    def test_public_service_surface_read_only(self):
        public = {n for n in dir(GatewayService) if not n.startswith("_")}
        self.assertEqual(public, {"Handler", "start", "stop", "reconnect", "handle_http", "latest_tick_envelope",
                                  "validate_subscription", "stream_events", "stream_invalid"})

    def test_single_wall_clock_read(self):
        hits = [f.name for f in FILES if re.search(r"\btime \. (time|time_ns|monotonic)\b|datetime \. now|utcnow",
                                                    code_tokens(f))]
        self.assertEqual(hits, ["clock.py"])

    def test_native_whitelist_still_intact(self):
        self.assertEqual(set(NATIVE_WHITELIST), {
            "initialize", "shutdown", "version", "terminal_info", "last_error", "symbols_get", "symbol_info",
            "symbol_select", "symbol_info_tick", "copy_ticks_from", "copy_ticks_range", "copy_rates_from",
            "copy_rates_from_pos", "copy_rates_range"})

    def test_allowed_timeframes_from_adapter(self):
        self.assertEqual(svc_mod.ALLOWED_TIMEFRAMES, {"M1", "M5", "M15", "M30", "H1", "H4", "D1"})


if __name__ == "__main__":
    unittest.main()
