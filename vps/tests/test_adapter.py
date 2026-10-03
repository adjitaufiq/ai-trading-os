import dataclasses
import json
import unittest
from datetime import datetime, timedelta, timezone

from mt5_bridge.adapter import AdapterConfig, ReadOnlyMT5Adapter, to_utc
from mt5_bridge.contracts import BRIDGE_SCHEMA_VERSION, Err, Ok
from mt5_bridge.native import NATIVE_WHITELIST, NativeCapabilityDenied, WhitelistedNative

from fake_mt5 import BARS, BARS_GAPPED, T0, TICKS, FakeMT5

FORBIDDEN = ["login", "account_info", "orders_get", "positions_get", "history_orders_get", "history_deals_get",
             "order_check", "order_send", "order_calc_margin", "order_calc_profit"]
UTC0 = datetime.fromtimestamp(T0, tz=timezone.utc)


def mk(**kw):
    fake = FakeMT5(**kw)
    a = ReadOnlyMT5Adapter(fake)
    a.initialize()
    return a, fake


def ok(r):
    assert isinstance(r, Ok), r
    return r.data


class Lifecycle(unittest.TestCase):
    def test_initialize_success_passes_no_identity(self):
        fake = FakeMT5()
        a = ReadOnlyMT5Adapter(fake, AdapterConfig(terminal_path="C:\\MT5\\terminal64.exe", timeout_ms=5000))
        self.assertTrue(ok(a.initialize()))
        self.assertTrue(a.initialized)
        _, _, kw = fake.calls[0]
        self.assertEqual(kw, {"path": "C:\\MT5\\terminal64.exe", "timeout": 5000})

    def test_initialize_failure_structured(self):
        a = ReadOnlyMT5Adapter(FakeMT5(init_ok=False))
        r = a.initialize()
        self.assertIsInstance(r, Err)
        self.assertEqual(r.error.mt5_error.to_wire(), {"code": -6, "description": "Terminal: Authorization failed"})
        self.assertFalse(a.initialized)

    def test_calls_before_initialize_rejected(self):
        a = ReadOnlyMT5Adapter(FakeMT5())
        r = a.version()
        self.assertIsInstance(r, Err)
        self.assertEqual(r.error.kind, "INVALID_REQUEST")

    def test_shutdown(self):
        a, fake = mk()
        ok(a.shutdown())
        self.assertFalse(a.initialized)
        self.assertEqual(fake.calls[-1][0], "shutdown")
        self.assertIsInstance(a.symbol_info_tick("XAUUSDm"), Err)
        n = len(fake.calls)
        ok(a.shutdown())  # idempotent, no second native shutdown
        self.assertEqual(len(fake.calls), n)

    def test_config_has_no_identity_or_secret_fields(self):
        names = {f.name for f in dataclasses.fields(AdapterConfig)}
        self.assertEqual(names, {"terminal_path", "timeout_ms", "portable"})
        with self.assertRaises(TypeError):
            AdapterConfig(password="x")  # type: ignore[call-arg]


class SystemCalls(unittest.TestCase):
    def test_version(self):
        a, _ = mk()
        self.assertEqual(ok(a.version()).to_wire(), {"terminal_version": 500, "build": 4620, "release_date": "02 Oct 2026"})

    def test_terminal_info_ping_us_and_observation_only(self):
        a, _ = mk(ping_last=23_456, trade_allowed=True)
        ti = ok(a.terminal_info())
        self.assertEqual(ti.terminal_ping_us, 23_456)
        self.assertEqual(ti.terminal_ping_ms, 23.456)
        self.assertTrue(ti.trade_allowed_observed)
        self.assertEqual(ti.authority, "OBSERVATION_ONLY")
        self.assertNotIn("ping_last", ti.to_wire())
        self.assertNotIn("trade_allowed", ti.to_wire())

    def test_last_error_structured(self):
        a, fake = mk()
        fake.err = (-2, "Invalid params")
        self.assertEqual(a.last_error().to_wire(), {"code": -2, "description": "Invalid params"})


class Errors(unittest.TestCase):
    def test_none_response_structured_and_raw_internal(self):
        for call, fn in [("version", lambda a: a.version()), ("terminal_info", lambda a: a.terminal_info()),
                         ("symbols_get", lambda a: a.symbols_get("*XAU*")), ("symbol_info", lambda a: a.symbol_info("X")),
                         ("symbol_info_tick", lambda a: a.symbol_info_tick("XAUUSDm")),
                         ("copy_ticks_range", lambda a: a.copy_ticks_range("XAUUSDm", T0, T0 + 60)),
                         ("copy_rates_range", lambda a: a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900))]:
            a, _ = mk(fail=[call])
            r = fn(a)
            self.assertIsInstance(r, Err, call)
            wire = r.error.to_wire()
            self.assertEqual(wire["mt5_error"], {"code": -10005, "description": f"IPC timeout in {call}"})
            self.assertNotIn("raw", json.dumps(wire))
            prov = a.internal_error_provenance()[-1]
            self.assertEqual(prov.native_call, call)
            self.assertEqual(prov.raw_last_error, (-10005, f"IPC timeout in {call}"))

    def test_symbol_info_unknown_symbol_is_error(self):
        a, _ = mk()
        self.assertIsInstance(a.symbol_info("NOPE"), Err)

    def test_symbol_select_false_is_error(self):
        a, _ = mk()
        self.assertIsInstance(a.symbol_select("NOPE"), Err)


class Discovery(unittest.TestCase):
    def test_symbols_get_group_passthrough(self):
        a, fake = mk()
        syms = ok(a.symbols_get("*XAU*"))
        self.assertEqual([s.broker_symbol for s in syms], ["XAUUSDm", "XAUUSDz"])
        self.assertEqual(fake.calls[-1], ("symbols_get", (), {"group": "*XAU*"}))
        self.assertEqual(len(ok(a.symbols_get())), 3)

    def test_symbol_info_and_select(self):
        a, fake = mk()
        s = ok(a.symbol_info("BTCUSDm"))
        self.assertEqual((s.broker_symbol, s.currency_base, s.digits), ("BTCUSDm", "BTC", 2))
        self.assertTrue(ok(a.symbol_select("XAUUSDm")))
        self.assertEqual(fake.calls[-1], ("symbol_select", ("XAUUSDm", True), {}))


class MarketData(unittest.TestCase):
    def test_symbol_info_tick_raw_s_and_ms(self):
        a, _ = mk()
        t = ok(a.symbol_info_tick("XAUUSDm"))
        self.assertEqual(t.raw_time_s, TICKS[-1]["time"])
        self.assertEqual(t.raw_time_msc, TICKS[-1]["time_msc"])
        self.assertEqual(t.time_precision, "ms")

    def test_copy_ticks_from_and_range(self):
        a, fake = mk()
        r = ok(a.copy_ticks_from("XAUUSDm", UTC0, 2))
        self.assertEqual([t.raw_time_msc for t in r.items], [x["time_msc"] for x in TICKS])
        self.assertEqual(fake.calls[-1][1][3], FakeMT5.COPY_TICKS_ALL)
        self.assertEqual(r.coverage.coverage_status, "UNKNOWN")
        r2 = ok(a.copy_ticks_range("XAUUSDm", T0, T0 + 60))
        self.assertEqual(r2.coverage.requested_from, T0)
        self.assertEqual(r2.coverage.requested_to, T0 + 60)

    def test_tick_ms_never_synthesized(self):
        rows = [dict(TICKS[0], time_msc=T0 * 1000 + 999)]
        a, _ = mk(ticks=rows)
        t = ok(a.copy_ticks_range("XAUUSDm", T0, T0 + 60)).items[0]
        self.assertEqual(t.raw_time_msc, T0 * 1000 + 999)
        self.assertNotEqual(t.raw_time_msc, t.raw_time_s * 1000)

    def test_copy_rates_variants_and_bar_second_precision(self):
        a, fake = mk()
        for r in [ok(a.copy_rates_from("XAUUSDm", "M5", UTC0 + timedelta(minutes=15), 3)),
                  ok(a.copy_rates_from_pos("XAUUSDm", "M5", 0, 3)),
                  ok(a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900))]:
            self.assertEqual([b.raw_time_s for b in r.items], [b["time"] for b in BARS])
            for b in r.items:
                self.assertEqual(b.time_precision, "s")
                self.assertNotIn("raw_time_msc", b.to_wire())
        self.assertEqual(fake.calls[-1][1][1], FakeMT5.TIMEFRAME_M5)

    def test_unsupported_timeframe_rejected(self):
        a, _ = mk()
        with self.assertRaises(ValueError):
            a.copy_rates_range("XAUUSDm", "W1", T0, T0 + 900)


class Temporal(unittest.TestCase):
    def test_requests_are_explicit_utc(self):
        a, fake = mk()
        a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900)
        _, args, _ = fake.calls[-1]
        for dt in args[2:4]:
            self.assertEqual(dt.utcoffset(), timedelta(0))
        self.assertEqual(int(args[2].timestamp()), T0)

    def test_naive_datetime_rejected(self):
        with self.assertRaises(ValueError):
            to_utc(datetime(2026, 1, 5, 8, 0))

    def test_non_utc_aware_converted_without_broker_offset(self):
        jakarta = timezone(timedelta(hours=7))
        dt = to_utc(datetime(2026, 1, 5, 15, 0, tzinfo=jakarta))
        self.assertEqual(int(dt.timestamp()), T0)
        self.assertEqual(dt.tzinfo, timezone.utc)

    def test_raw_times_untouched_no_broker_offset(self):
        a, _ = mk()
        bars = ok(a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900)).items
        self.assertEqual(bars[0].raw_time_s, BARS[0]["time"])  # no +2h / Exness offset applied


class Coverage(unittest.TestCase):
    def test_contiguous_array_is_not_complete(self):
        a, _ = mk()
        c = ok(a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900)).coverage
        self.assertEqual(c.coverage_status, "UNKNOWN")
        self.assertEqual(c.returned_count, 3)

    def test_gap_is_partial(self):
        a, _ = mk(bars=BARS_GAPPED)
        self.assertEqual(ok(a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 1200)).coverage.coverage_status, "PARTIAL")

    def test_range_not_spanned_is_partial(self):
        a, _ = mk()
        self.assertEqual(ok(a.copy_rates_range("XAUUSDm", "M5", T0 - 300, T0 + 900)).coverage.coverage_status, "PARTIAL")

    def test_empty(self):
        a, _ = mk(bars=[])
        c = ok(a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900)).coverage
        self.assertEqual((c.coverage_status, c.oldest_returned_at), ("EMPTY", None))

    def test_count_based_never_complete(self):
        a, _ = mk()
        self.assertEqual(ok(a.copy_rates_from_pos("XAUUSDm", "M5", 0, 3)).coverage.coverage_status, "UNKNOWN")
        self.assertEqual(ok(a.copy_rates_from("XAUUSDm", "M5", UTC0, 3)).coverage.coverage_status, "UNKNOWN")


class Immutability(unittest.TestCase):
    def test_normalized_output_frozen(self):
        a, _ = mk()
        r = ok(a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900))
        self.assertIsInstance(r.items, tuple)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            r.items[0].close = 1.0  # type: ignore[misc]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            ok(a.terminal_info()).trade_allowed_observed = False  # type: ignore[misc]


class Whitelist(unittest.TestCase):
    def test_whitelist_exact(self):
        self.assertEqual(NATIVE_WHITELIST, frozenset({
            "initialize", "shutdown", "version", "terminal_info", "last_error",
            "symbols_get", "symbol_info", "symbol_select",
            "symbol_info_tick", "copy_ticks_from", "copy_ticks_range",
            "copy_rates_from", "copy_rates_from_pos", "copy_rates_range"}))

    def test_proxy_blocks_forbidden_members(self):
        fake = FakeMT5()
        p = WhitelistedNative(fake)
        for name in FORBIDDEN:
            with self.assertRaises(NativeCapabilityDenied):
                getattr(p, name)
        with self.assertRaises(NativeCapabilityDenied):
            p.order_send = lambda: None  # type: ignore[attr-defined]
        self.assertEqual(fake.forbidden_hits, [])

    def test_adapter_internal_native_gate(self):
        a, _ = mk()
        for name in FORBIDDEN:
            with self.assertRaises(NativeCapabilityDenied):
                a._native(name)

    def test_adapter_has_no_forbidden_methods(self):
        public = {m for m in dir(ReadOnlyMT5Adapter) if not m.startswith("_")}
        self.assertEqual(public, {"initialize", "shutdown", "version", "terminal_info", "last_error", "initialized",
                                  "internal_error_provenance", "symbols_get", "symbol_info", "symbol_select",
                                  "symbol_info_tick", "copy_ticks_from", "copy_ticks_range", "copy_rates_from",
                                  "copy_rates_from_pos", "copy_rates_range"})

    def test_full_run_never_touches_forbidden(self):
        a, fake = mk()
        a.version(); a.terminal_info(); a.symbols_get("*XAU*"); a.symbol_info("XAUUSDm"); a.symbol_select("XAUUSDm")
        a.symbol_info_tick("XAUUSDm"); a.copy_ticks_from("XAUUSDm", T0, 2); a.copy_ticks_range("XAUUSDm", T0, T0 + 60)
        a.copy_rates_from("XAUUSDm", "M5", T0, 3); a.copy_rates_from_pos("XAUUSDm", "M5", 0, 3)
        a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900); a.shutdown()
        self.assertEqual(fake.forbidden_hits, [])
        self.assertTrue({c[0] for c in fake.calls} <= NATIVE_WHITELIST)


class Determinism(unittest.TestCase):
    def run_once(self):
        a, fake = mk()
        out = [ok(a.version()).to_wire(), ok(a.terminal_info()).to_wire(),
               [s.to_wire() for s in ok(a.symbols_get("*XAU*"))],
               ok(a.copy_ticks_range("XAUUSDm", T0, T0 + 60)).to_wire(),
               ok(a.copy_rates_range("XAUUSDm", "M5", T0, T0 + 900)).to_wire()]
        return json.dumps(out, sort_keys=True), [(c[0], repr(c[1]), repr(c[2])) for c in fake.calls]

    def test_repeat_identical(self):
        self.assertEqual(self.run_once(), self.run_once())

    def test_schema_version_matches_frozen_ts_contract(self):
        with open("../src/core/broker/bridge/types.ts", encoding="utf8") as f:
            self.assertIn(f'BRIDGE_SCHEMA_VERSION = "{BRIDGE_SCHEMA_VERSION}"', f.read())


if __name__ == "__main__":
    unittest.main()
