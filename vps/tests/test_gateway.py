"""Stage 3.0B-2B hermetic E2E: FakeMT5 -> ReadOnlyMT5Adapter -> GatewayService -> real loopback
HTTP/WS server -> raw socket client. Nothing in the transport is mocked."""
import asyncio
import json
import unittest
from datetime import datetime, timezone

from mt5_bridge.adapter import ReadOnlyMT5Adapter
from mt5_bridge.contracts import BRIDGE_SCHEMA_VERSION
from mt5_bridge.native import NATIVE_WHITELIST
from mt5_gateway.clock import FakeTransportClock
from mt5_gateway.server import GatewayServer
from mt5_gateway.service import GatewayService

from fake_mt5 import BARS_GAPPED, T0, TICKS, FakeMT5
from loopback_client import WsClient, http

CLOCK0 = T0 * 1000 + 10_000
ENVELOPE_KEYS = {"schema_version", "bridge_instance_id", "connection_epoch", "request_id", "sequence", "delivery",
                 "source", "source_mode", "capability", "timing", "latency", "ok", "data", "error"}
TIMING_KEYS = {"source_event_at", "bridge_received_at", "bridge_sent_at", "client_sent_at", "client_received_at"}
LATENCY_KEYS = {"source_arrival_delay_observed_ms", "bridge_processing_ms", "bridge_to_client_apparent_delay_ms",
                "transport_rtt_ms"}
FROM = "2026-01-05T08:00:00Z"
TO = "2026-01-05T08:15:00Z"


class GatewayCase(unittest.IsolatedAsyncioTestCase):
    fake_kwargs: dict = {}

    async def asyncSetUp(self):
        self.fake = self.make_fake()
        self.adapter = ReadOnlyMT5Adapter(self.fake)
        self.svc = GatewayService(self.adapter, FakeTransportClock(CLOCK0), "SIMULATION", "gw-test")
        self.svc.start()
        self.server = GatewayServer(self.svc)
        await self.server.start()
        self.port = self.server.port

    def make_fake(self):
        return FakeMT5(**self.fake_kwargs)

    async def asyncTearDown(self):
        await self.server.stop()
        self.svc.stop()
        self.assertEqual(self.fake.forbidden_hits, [])

    async def get(self, path, **kw):
        return await http(self.port, path, **kw)

    def assert_envelope(self, env, cap, delivery):
        self.assertEqual(set(env), ENVELOPE_KEYS)
        self.assertEqual(set(env["timing"]), TIMING_KEYS)
        self.assertEqual(set(env["latency"]), LATENCY_KEYS)
        self.assertEqual(env["schema_version"], BRIDGE_SCHEMA_VERSION)
        self.assertEqual(env["bridge_instance_id"], "gw-test")
        self.assertEqual(env["source"], "EXNESS_MT5")
        self.assertEqual(env["source_mode"], "SIMULATION")
        self.assertEqual(env["capability"], cap)
        self.assertEqual(env["delivery"], delivery)
        self.assertRegex(env["request_id"], r"^[0-9a-f]{32}$")
        t = env["timing"]
        self.assertGreaterEqual(t["bridge_sent_at"], t["bridge_received_at"])
        self.assertIsNone(t["client_sent_at"])
        self.assertIsNone(t["client_received_at"])
        self.assertEqual(env["latency"]["bridge_processing_ms"], t["bridge_sent_at"] - t["bridge_received_at"])
        self.assertIsNone(env["latency"]["transport_rtt_ms"])
        self.assertIsNone(env["latency"]["bridge_to_client_apparent_delay_ms"])
        if env["ok"]:
            self.assertIsNone(env["error"])
        else:
            self.assertIsNone(env["data"])
            self.assertEqual(set(env["error"]), {"kind", "message", "mt5_error"})
            self.assertIn(env["error"]["kind"], {"MT5_ERROR", "CAPABILITY_DENIED", "INVALID_REQUEST", "NOT_FOUND"})


class Http(GatewayCase):
    async def test_bound_to_loopback(self):
        self.assertEqual(self.server.bound_host, "127.0.0.1")

    async def test_health_read_only(self):
        st, h, env = await self.get("/v1/health")
        self.assertEqual(st, 200)
        self.assert_envelope(env, "SYSTEM.HEALTH", "LIVE")
        self.assertEqual(env["data"], {"bridge_instance_id": "gw-test", "connection_epoch": 0,
                                       "source_mode": "SIMULATION", "terminal_connected": True})
        self.assertEqual(h["x-bridge-authority"], "READ_ONLY_OBSERVATION")
        self.assertNotIn("execution", json.dumps(env).lower())

    async def test_terminal_observation_only(self):
        st, _, env = await self.get("/v1/terminal")
        self.assertEqual(st, 200)
        self.assert_envelope(env, "SYSTEM.TERMINAL_INFO", "LIVE")
        d = env["data"]
        self.assertTrue(d["trade_allowed_observed"])
        self.assertEqual(d["authority"], "OBSERVATION_ONLY")
        self.assertEqual(d["terminal_ping_us"], 23_456)
        self.assertEqual(d["terminal_ping_ms"], 23.456)

    async def test_symbol_list_and_group_filter_no_first_match(self):
        _, _, all_ = await self.get("/v1/symbols")
        self.assertEqual(len(all_["data"]), 3)
        st, _, env = await self.get("/v1/symbols?group=*XAU*")
        self.assertEqual(st, 200)
        self.assert_envelope(env, "DISCOVERY.SYMBOLS", "LIVE")
        self.assertEqual([s["broker_symbol"] for s in env["data"]], ["XAUUSDm", "XAUUSDz"])  # both candidates kept
        self.assertEqual(self.fake.calls[-1], ("symbols_get", (), {"group": "*XAU*"}))

    async def test_invalid_group_rejected_before_native(self):
        n = len(self.fake.calls)
        st, _, env = await self.get("/v1/symbols?group=%3Bdrop")
        self.assertEqual(st, 400)
        self.assertEqual(env["error"]["kind"], "INVALID_REQUEST")
        self.assertEqual(len(self.fake.calls), n)

    async def test_symbol_metadata(self):
        st, _, env = await self.get("/v1/symbols/XAUUSDm")
        self.assertEqual(st, 200)
        self.assert_envelope(env, "DISCOVERY.SYMBOL_SPEC", "LIVE")
        self.assertEqual(env["data"]["broker_symbol"], "XAUUSDm")
        self.assertEqual(env["data"]["digits"], 2)

    async def test_unknown_symbol_not_found(self):
        st, _, env = await self.get("/v1/symbols/NOPE")
        self.assertEqual(st, 404)
        self.assert_envelope(env, "DISCOVERY.SYMBOL_SPEC", "LIVE")
        self.assertEqual(env["error"]["kind"], "NOT_FOUND")

    async def test_partial_symbol_is_not_fuzzy_resolved(self):
        st, _, env = await self.get("/v1/symbols/XAUUSD")
        self.assertEqual(st, 404)
        self.assertEqual(env["error"]["kind"], "NOT_FOUND")

    async def test_latest_tick_live_raw_preserved(self):
        st, _, env = await self.get("/v1/ticks/latest/XAUUSDm")
        self.assertEqual(st, 200)
        self.assert_envelope(env, "MARKET_DATA.TICKS", "LIVE")
        d = env["data"]
        self.assertEqual(d["raw_time_s"], TICKS[-1]["time"])
        self.assertEqual(d["raw_time_msc"], TICKS[-1]["time_msc"])
        self.assertEqual(d["time_precision"], "ms")
        self.assertEqual(env["timing"]["source_event_at"], TICKS[-1]["time_msc"])
        self.assertEqual(env["latency"]["source_arrival_delay_observed_ms"],
                         env["timing"]["bridge_received_at"] - TICKS[-1]["time_msc"])

    async def test_historical_ticks_range_backfill(self):
        st, _, env = await self.get(f"/v1/ticks/XAUUSDm?mode=range&from={FROM}&to={TO}")
        self.assertEqual(st, 200)
        self.assert_envelope(env, "MARKET_DATA.TICKS", "BACKFILL")
        self.assertEqual([t["raw_time_msc"] for t in env["data"]["items"]], [t["time_msc"] for t in TICKS])
        self.assertEqual(env["data"]["coverage"]["coverage_status"], "UNKNOWN")
        self.assertIsNone(env["timing"]["source_event_at"])

    async def test_historical_ticks_from_count(self):
        st, _, env = await self.get(f"/v1/ticks/XAUUSDm?mode=from&from={FROM}&count=1")
        self.assertEqual(st, 200)
        self.assertEqual(len(env["data"]["items"]), 1)
        self.assertEqual(env["delivery"], "BACKFILL")

    async def test_historical_bars_range_valid_timeframe(self):
        st, _, env = await self.get(f"/v1/bars/XAUUSDm/M5?mode=range&from={FROM}&to={TO}")
        self.assertEqual(st, 200)
        self.assert_envelope(env, "MARKET_DATA.BARS", "BACKFILL")
        bars = env["data"]["items"]
        self.assertEqual([b["raw_time_s"] for b in bars], [T0, T0 + 300, T0 + 600])
        self.assertTrue(all(b["time_precision"] == "s" and b["timeframe"] == "M5" for b in bars))
        cov = env["data"]["coverage"]
        self.assertEqual(cov["coverage_status"], "UNKNOWN")  # never upgraded by transport success
        self.assertEqual((cov["requested_from"], cov["requested_to"], cov["returned_count"]), (T0, T0 + 900, 3))
        self.assertEqual((cov["oldest_returned_at"], cov["newest_returned_at"]), (T0, T0 + 600))
        self.assertIn("not proven", cov["reason"])

    async def test_bars_from_and_pos(self):
        st, _, env = await self.get(f"/v1/bars/XAUUSDm/M5?mode=from&from={TO}&count=2")
        self.assertEqual((st, len(env["data"]["items"])), (200, 2))
        st, _, env = await self.get("/v1/bars/XAUUSDm/M5?mode=pos&start=0&count=2")
        self.assertEqual((st, env["data"]["coverage"]["coverage_status"]), (200, "UNKNOWN"))

    async def test_invalid_timeframe_rejected_before_native(self):
        n = len(self.fake.calls)
        st, _, env = await self.get(f"/v1/bars/XAUUSDm/M7?mode=range&from={FROM}&to={TO}")
        self.assertEqual(st, 400)
        self.assert_envelope(env, "MARKET_DATA.BARS", "BACKFILL")
        self.assertEqual(env["error"]["kind"], "INVALID_REQUEST")
        self.assertEqual(len(self.fake.calls), n)

    async def test_non_utc_aware_converted(self):
        st, _, env = await self.get("/v1/bars/XAUUSDm/M5?mode=range&from=2026-01-05T15:00:00%2B07:00"
                                    "&to=2026-01-05T15:15:00%2B07:00")
        self.assertEqual(st, 200)
        self.assertEqual(env["data"]["coverage"]["requested_from"], T0)
        name, args, _ = self.fake.calls[-1]
        self.assertEqual(name, "copy_rates_range")
        self.assertEqual(args[2], datetime(2026, 1, 5, 8, 0, tzinfo=timezone.utc))
        self.assertEqual(args[2].utcoffset().total_seconds(), 0)

    async def test_naive_datetime_rejected(self):
        n = len(self.fake.calls)
        st, _, env = await self.get("/v1/ticks/XAUUSDm?mode=range&from=2026-01-05T08:00:00&to=2026-01-05T08:15:00")
        self.assertEqual(st, 400)
        self.assertIn("naive", env["error"]["message"])
        self.assertEqual(len(self.fake.calls), n)

    async def test_malformed_queries(self):
        for q in ["mode=range&from=yesterday&to=" + TO, "mode=range&from=" + TO + "&to=" + FROM,
                  "mode=from&from=" + FROM + "&count=-1", "mode=from&from=" + FROM + "&count=0",
                  "mode=exec", "", "mode=range&from=" + FROM + "&to=" + TO + "&extra=1",
                  "mode=range&mode=range&from=" + FROM + "&to=" + TO, "mode=from&from=" + FROM]:
            st, _, env = await self.get(f"/v1/ticks/XAUUSDm?{q}")
            self.assertEqual(st, 400, q)
            self.assertEqual(env["error"]["kind"], "INVALID_REQUEST", q)

    async def test_invalid_symbol_path(self):
        st, _, env = await self.get("/v1/ticks/latest/XAU%20USD")
        self.assertEqual((st, env["error"]["kind"]), (400, "INVALID_REQUEST"))

    async def test_unknown_routes_not_found_no_native_call(self):
        n = len(self.fake.calls)
        for p in ["/v1/invoke", "/invoke", "/rpc", "/command", "/execute", "/v1/order_send", "/v1/positions",
                  "/v1/account", "/v1/login", "/v2/health", "/v1/symbols/a/b", "/v1/ticks/latest", "/"]:
            st, _, body = await self.get(p)
            self.assertEqual(st, 404, p)
            self.assertEqual(body, {"detail": "not found"})
        for p in ["/invoke", "/rpc", "/command", "/execute"]:
            st, _, _ = await self.get(p, method="POST")
            self.assertEqual(st, 404, p)
        self.assertEqual(len(self.fake.calls), n)

    async def test_unsupported_method(self):
        n = len(self.fake.calls)
        for m in ["POST", "PUT", "DELETE", "PATCH"]:
            st, h, _ = await self.get("/v1/health", method=m)
            self.assertEqual(st, 405, m)
            self.assertEqual(h["allow"], "GET")
        st, _, _ = await self.get("/v1/stream", method="POST")
        self.assertEqual(st, 405)
        self.assertEqual(len(self.fake.calls), n)

    async def test_client_request_id_not_trusted(self):
        _, _, env = await self.get("/v1/health", headers={"X-Request-Id": "attacker-chosen"})
        self.assertNotEqual(env["request_id"], "attacker-chosen")
        self.assertRegex(env["request_id"], r"^[0-9a-f]{32}$")

    async def test_serialization_safe_and_raw_untouched(self):
        _, _, env = await self.get(f"/v1/bars/XAUUSDm/M5?mode=range&from={FROM}&to={TO}")
        self.assertEqual(json.loads(json.dumps(env, allow_nan=False)), env)
        self.assertEqual(env["data"]["items"][0]["raw_time_s"], T0)  # no broker offset, no transport time


class Coverage(GatewayCase):
    async def test_partial_history_preserved(self):
        self.fake.bars = BARS_GAPPED
        _, _, env = await self.get(f"/v1/bars/XAUUSDm/M5?mode=range&from={FROM}&to=2026-01-05T08:20:00Z")
        self.assertEqual(env["data"]["coverage"]["coverage_status"], "PARTIAL")

    async def test_empty_history_preserved(self):
        self.fake.bars, self.fake.ticks = [], []
        st, _, env = await self.get(f"/v1/bars/XAUUSDm/M5?mode=range&from={FROM}&to={TO}")
        self.assertEqual((st, env["data"]["coverage"]["coverage_status"], env["data"]["items"]), (200, "EMPTY", []))
        _, _, env = await self.get(f"/v1/ticks/XAUUSDm?mode=range&from={FROM}&to={TO}")
        self.assertEqual(env["data"]["coverage"]["coverage_status"], "EMPTY")


class NativeErrors(GatewayCase):
    fake_kwargs = {"fail": ("copy_rates_range", "terminal_info")}

    async def test_history_native_error_mapped(self):
        st, _, env = await self.get(f"/v1/bars/XAUUSDm/M5?mode=range&from={FROM}&to={TO}")
        self.assertEqual(st, 502)
        self.assert_envelope(env, "MARKET_DATA.BARS", "BACKFILL")
        self.assertEqual(env["error"], {"kind": "MT5_ERROR", "message": "HISTORY_UNAVAILABLE",
                                        "mt5_error": {"code": -10005, "description": "IPC timeout in copy_rates_range"}})

    async def test_terminal_native_error_and_health_degrades(self):
        st, _, env = await self.get("/v1/terminal")
        self.assertEqual((st, env["error"]["kind"], env["error"]["message"]), (502, "MT5_ERROR", "NATIVE_ERROR"))
        st, _, env = await self.get("/v1/health")
        self.assertEqual((st, env["data"]["terminal_connected"]), (200, False))
        # raw native tuple stays internal (adapter provenance), not on the wire
        self.assertTrue(self.adapter.internal_error_provenance())
        self.assertNotIn("raw_last_error", json.dumps(env))


class TerminalUnavailable(GatewayCase):
    fake_kwargs = {"init_ok": False}

    async def test_terminal_unavailable(self):
        st, _, env = await self.get("/v1/ticks/latest/XAUUSDm")
        self.assertEqual(st, 503)
        self.assertEqual(env["error"], {"kind": "MT5_ERROR", "message": "TERMINAL_UNAVAILABLE", "mt5_error": None})


class Exploding(FakeMT5):
    def terminal_info(self):
        raise RuntimeError("boom-internal-detail at C:\\vps\\path.py line 42")


class InternalError(GatewayCase):
    def make_fake(self):
        return Exploding()

    async def test_internal_error_sanitized(self):
        st, _, env = await self.get("/v1/terminal")
        self.assertEqual(st, 500)
        self.assert_envelope(env, "SYSTEM.TERMINAL_INFO", "LIVE")
        self.assertEqual(env["error"], {"kind": "MT5_ERROR", "message": "INTERNAL_GATEWAY_ERROR", "mt5_error": None})
        text = json.dumps(env)
        for leak in ["boom", "RuntimeError", "Traceback", "path.py"]:
            self.assertNotIn(leak, text)
        self.assertTrue(self.svc.internal_errors)


class SequenceEpoch(GatewayCase):
    async def test_sequence_strictly_increasing(self):
        seqs = [(await self.get("/v1/health"))[2]["sequence"] for _ in range(5)]
        self.assertEqual(seqs, list(range(seqs[0], seqs[0] + 5)))

    async def test_concurrent_requests_unique_ids_and_ordered_sequences(self):
        paths = ["/v1/health", "/v1/terminal", "/v1/symbols", "/v1/ticks/latest/XAUUSDm",
                 f"/v1/bars/XAUUSDm/M5?mode=range&from={FROM}&to={TO}", "/v1/nope", "/v1/bars/X/M7?mode=pos"] * 8
        ws, _, _ = await WsClient.connect(self.port)

        async def stream():
            await ws.send_json({"action": "subscribe", "stream": "ticks", "symbols": ["XAUUSDm", "BTCUSDm"] * 5})
            return [await ws.recv_json() for _ in range(10)]
        results = await asyncio.gather(*(self.get(p) for p in paths), stream())
        envs = [r[2] for r in results[:-1] if "sequence" in r[2]] + results[-1]
        await ws.close()
        self.assertEqual(len(envs), 48 + 10)
        seqs = [e["sequence"] for e in envs]
        rids = [e["request_id"] for e in envs]
        self.assertEqual(len(set(seqs)), len(seqs))
        self.assertEqual(len(set(rids)), len(rids))
        self.assertEqual(sorted(seqs), list(range(min(seqs), min(seqs) + len(seqs))))
        by_seq = sorted(envs, key=lambda e: e["sequence"])
        sent = [e["timing"]["bridge_sent_at"] for e in by_seq]
        self.assertEqual(sent, sorted(sent))  # canonical assignment: sequence order == emission order
        self.assertEqual(len(set(sent)), len(sent))

    async def test_reconnect_increments_epoch_without_sequence_reset(self):
        _, _, a = await self.get("/v1/health")
        self.assertEqual(a["connection_epoch"], 0)
        self.assertTrue(self.svc.reconnect())
        _, _, b = await self.get("/v1/health")
        self.assertEqual(b["connection_epoch"], 1)
        self.assertEqual(b["data"]["connection_epoch"], 1)
        self.assertEqual(b["sequence"], a["sequence"] + 1)
        self.svc.reconnect()
        results = await asyncio.gather(*(self.get("/v1/terminal") for _ in range(10)))
        seqs = sorted(r[2]["sequence"] for r in results)
        self.assertEqual(seqs, list(range(b["sequence"] + 1, b["sequence"] + 11)))
        self.assertTrue(all(r[2]["connection_epoch"] == 2 for r in results))


class WebSocket(GatewayCase):
    async def test_connect_subscribe_receive_live(self):
        ws, st, h = await WsClient.connect(self.port)
        self.assertEqual(st, 101)
        self.assertEqual(h["x-bridge-authority"], "READ_ONLY_OBSERVATION")
        await ws.send_json({"action": "subscribe", "stream": "ticks", "symbols": ["XAUUSDm"]})
        env = await ws.recv_json()
        self.assert_envelope(env, "MARKET_DATA.TICKS", "LIVE")
        self.assertTrue(env["ok"])
        self.assertEqual(env["data"]["raw_time_s"], TICKS[-1]["time"])
        self.assertEqual(env["data"]["raw_time_msc"], TICKS[-1]["time_msc"])
        self.assertEqual(env["timing"]["source_event_at"], TICKS[-1]["time_msc"])
        self.assertEqual(env["connection_epoch"], 0)
        op, data = await ws.close()
        self.assertEqual(op, 0x8)

    async def test_stream_sequence_monotonic(self):
        ws, _, _ = await WsClient.connect(self.port)
        await ws.send_json({"action": "subscribe", "stream": "ticks", "symbols": ["XAUUSDm", "BTCUSDm", "XAUUSDz"]})
        seqs = [(await ws.recv_json())["sequence"] for _ in range(3)]
        await ws.send_json({"action": "subscribe", "stream": "ticks", "symbols": ["XAUUSDm"]})
        seqs.append((await ws.recv_json())["sequence"])
        self.assertEqual(seqs, list(range(seqs[0], seqs[0] + 4)))
        await ws.close()

    async def test_invalid_subscription_and_commands_rejected(self):
        ws, _, _ = await WsClient.connect(self.port)
        n = len(self.fake.calls)
        bad = [
            {"action": "invoke", "stream": "ticks", "symbols": ["XAUUSDm"]},
            {"action": "subscribe", "stream": "orders", "symbols": ["XAUUSDm"]},
            {"action": "subscribe", "stream": "ticks", "symbols": ["XAUUSDm"], "method": "order_check"},
            {"method": "symbol_info_tick", "params": ["XAUUSDm"]},
            {"action": "subscribe", "stream": "ticks", "symbols": []},
            {"action": "subscribe", "stream": "ticks", "symbols": ["bad symbol"]},
            ["subscribe"],
        ]
        for msg in bad:
            await ws.send_json(msg)
            env = await ws.recv_json()
            self.assert_envelope(env, "MARKET_DATA.TICKS", "LIVE")
            self.assertEqual(env["error"]["kind"], "INVALID_REQUEST", msg)
        await ws.send_raw(0x1, b"not json{")
        self.assertEqual((await ws.recv_json())["error"]["kind"], "INVALID_REQUEST")
        self.assertEqual(len(self.fake.calls), n)  # nothing reached the adapter
        await ws.close()

    async def test_disconnect_no_side_effects(self):
        ws, _, _ = await WsClient.connect(self.port)
        await ws.send_json({"action": "subscribe", "stream": "ticks", "symbols": ["XAUUSDm"]})
        await ws.recv_json()
        ws.w.close()  # abrupt drop
        await asyncio.sleep(0.05)
        names = {c[0] for c in self.fake.calls}
        self.assertLessEqual(names, set(NATIVE_WHITELIST))
        st, _, env = await self.get("/v1/health")
        self.assertEqual((st, env["data"]["terminal_connected"]), (200, True))

    async def test_binary_frame_closes(self):
        ws, _, _ = await WsClient.connect(self.port)
        await ws.send_raw(0x2, b"\x00\x01")
        op, data = await ws.recv()
        self.assertEqual((op, data), (0x8, b"\x03\xeb"))


class Determinism(unittest.IsolatedAsyncioTestCase):
    PATHS = ["/v1/health", "/v1/terminal", "/v1/symbols?group=*XAU*", "/v1/symbols/NOPE", "/v1/ticks/latest/XAUUSDm",
             f"/v1/ticks/XAUUSDm?mode=range&from={FROM}&to={TO}",
             f"/v1/bars/XAUUSDm/M5?mode=range&from={FROM}&to={TO}", "/v1/bars/XAUUSDm/M7?mode=pos"]

    async def run_once(self):
        svc = GatewayService(ReadOnlyMT5Adapter(FakeMT5()), FakeTransportClock(CLOCK0), "SIMULATION")
        svc.start()
        srv = GatewayServer(svc)
        await srv.start()
        out = [(await http(srv.port, p))[2] for p in self.PATHS]
        await srv.stop()
        return out

    @staticmethod
    def projection(env):
        return {"capability": env["capability"], "delivery": env["delivery"], "source": env["source"],
                "source_mode": env["source_mode"], "schema_version": env["schema_version"], "ok": env["ok"],
                "data": {k: v for k, v in env["data"].items() if k != "bridge_instance_id"}
                if isinstance(env["data"], dict) else env["data"],
                "error": env["error"], "sequence": env["sequence"], "epoch": env["connection_epoch"],
                "source_event_at": env["timing"]["source_event_at"]}

    async def test_repeat_runs_equal_projection(self):
        a, b = await self.run_once(), await self.run_once()
        self.assertEqual([self.projection(e) for e in a], [self.projection(e) for e in b])
        self.assertNotEqual(a[0]["bridge_instance_id"], b[0]["bridge_instance_id"])


if __name__ == "__main__":
    unittest.main()
