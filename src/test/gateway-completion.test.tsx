// Stage 3.0B-2C completion matrix: HTTP, health, WS, pipeline dispositions, dashboard honesty.
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrokerGatewayClient, type FetchLike, type WebSocketLike } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { ExplicitFreshnessPolicy } from "@/core/broker/gateway/health";
import { GatewayMarketIngest } from "@/core/broker/gateway/GatewayMarketIngest";
import type { ClientError, ClientTickObservation, GatewayHealthState } from "@/core/broker/gateway/types";
import { BrokerFeedPipeline } from "@/core/broker/BrokerFeedPipeline";
import type { BrokerMarketEvent } from "@/core/broker/types";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { EXECUTION_ENABLED, OPERATING_MODE, type MarketEvent } from "@/core/contracts";
import { GatewayStatusView, UNPROBED_STATE } from "@/components/GatewayStatusPanel";

const T0 = Date.UTC(2026, 0, 5, 8, 0, 0);
const mono = () => { let t = 0; return { now: () => (t += 5) }; };

type Over = Record<string, unknown>;
function envelope(cap: string, delivery: string, data: unknown, o: Over = {}, sourceEventAt: number | null = null, recv = T0 + 10_000) {
  return {
    schema_version: "3.0B-1", bridge_instance_id: "gw-u", connection_epoch: 0, request_id: "b".repeat(32), sequence: 1,
    delivery, source: "EXNESS_MT5", source_mode: "SIMULATION", capability: cap,
    timing: { source_event_at: sourceEventAt, bridge_received_at: recv, bridge_sent_at: recv + 1, client_sent_at: null, client_received_at: null },
    latency: { source_arrival_delay_observed_ms: sourceEventAt === null ? null : recv - sourceEventAt, bridge_processing_ms: 1, bridge_to_client_apparent_delay_ms: null, transport_rtt_ms: null },
    ok: true, data, error: null, ...o,
  };
}
const tick = (msc: number, bid = 2345.1) => ({ broker_symbol: "XAUUSDm", raw_time_s: Math.floor(msc / 1000), raw_time_msc: msc, time_precision: "ms", bid, ask: bid + 0.12, last: 0, volume: 0, flags: 6 });
const tickEnv = (seq: number, msc: number, o: Over = {}, bid?: number) =>
  envelope("MARKET_DATA.TICKS", "LIVE", tick(msc, bid), { sequence: seq, request_id: `r${seq}`, ...o }, msc, T0 + 10_000 + seq);
const terminal = (connected: boolean) => ({ connected, terminal_ping_us: 23456, terminal_ping_ms: 23.456, retransmission: 0, trade_allowed_observed: true, tradeapi_disabled_observed: false, authority: "OBSERVATION_ONLY" });
const errEnv = (cap: string, delivery: string, kind: string, message: string) => envelope(cap, delivery, null, { ok: false, data: null, error: { kind, message, mt5_error: null } });

function recorder(status: number, body: unknown) {
  const urls: string[] = [];
  const f: FetchLike = async (u) => { urls.push(u); return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }; };
  return { urls, f };
}
const mk = (f: FetchLike, extra: Partial<ConstructorParameters<typeof BrokerGatewayClient>[0]> = {}) =>
  new BrokerGatewayClient({ config: makeGatewayConfig({ httpBaseUrl: "http://127.0.0.1:8000", wsBaseUrl: "ws://127.0.0.1:8000" }), wallClock: new ReplayClock(T0 + 20_000), monoClock: mono(), fetchImpl: f, ...extra });

const EXEC_INVARIANT = { execution_capability: "ABSENT", execution_authorization: "DISABLED" };

// ---------------- HTTP ----------------
describe("2C HTTP matrix", () => {
  it("getLatestTick returns validated LIVE tick with raw time preserved", async () => {
    const r = await mk(recorder(200, tickEnv(1, T0 + 7)).f).getLatestTick("XAUUSDm");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.delivery).toBe("LIVE");
      expect(r.data.raw_time_msc).toBe(T0 + 7);
      expect(r.envelope.timing.source_event_at).toBe(T0 + 7);
    }
  });
  it("getTerminal returns observation-only terminal info and drives terminal health", async () => {
    const c = mk(recorder(200, envelope("SYSTEM.TERMINAL_INFO", "LIVE", terminal(false))).f);
    const r = await c.getTerminal();
    expect(r.ok && r.data.authority).toBe("OBSERVATION_ONLY");
    expect(c.health.snapshot().terminal_health).toBe("DOWN");
  });
  it("query encoding: group filter and path symbols are URL-encoded; only typed params sent", async () => {
    const rec = recorder(200, envelope("DISCOVERY.SYMBOLS", "LIVE", []));
    await mk(rec.f).getSymbols("XAU*,!BTC*");
    expect(rec.urls[0]).toBe("http://127.0.0.1:8000/v1/symbols?group=XAU*%2C%21BTC*");
    const bars = recorder(200, envelope("MARKET_DATA.BARS", "BACKFILL", { items: [], coverage: { requested_from: null, requested_to: null, returned_count: 0, oldest_returned_at: null, newest_returned_at: null, coverage_status: "EMPTY", reason: null } }));
    await mk(bars.f).getBars({ symbol: "XAU.USD#m", timeframe: "M5", mode: "pos", start: 0, count: 3 });
    expect(bars.urls[0]).toBe("http://127.0.0.1:8000/v1/bars/XAU.USD%23m/M5?mode=pos&start=0&count=3");
  });
  it("UTC serialization: explicit Z; non-UTC offset input normalized to UTC; no broker offset", async () => {
    const rec = recorder(200, envelope("MARKET_DATA.TICKS", "BACKFILL", { items: [], coverage: { requested_from: T0, requested_to: T0 + 60_000, returned_count: 0, oldest_returned_at: null, newest_returned_at: null, coverage_status: "EMPTY", reason: null } }));
    const from = Date.parse("2026-01-05T10:00:00+02:00"); // == 08:00Z
    await mk(rec.f).getTicks({ symbol: "XAUUSDm", mode: "range", from, to: from + 60_000 });
    const q = new URL(rec.urls[0]!).searchParams;
    expect(q.get("from")).toBe("2026-01-05T08:00:00.000Z");
    expect(q.get("to")).toBe("2026-01-05T08:01:00.000Z");
    const bad = await mk(rec.f).getTicks({ symbol: "XAUUSDm", mode: "range", from: 1.5, to: 2 });
    expect(!bad.ok && bad.error.kind).toBe("INVALID_REQUEST");
    expect(rec.urls).toHaveLength(1); // invalid input never reached the network
  });
  it("structured gateway errors map to the client taxonomy with BridgeError preserved", async () => {
    const internal = await mk(recorder(500, errEnv("SYSTEM.TERMINAL_INFO", "LIVE", "MT5_ERROR", "INTERNAL_GATEWAY_ERROR")).f).getTerminal();
    expect(!internal.ok && internal.error).toMatchObject({ kind: "GATEWAY_ERROR", http_status: 500, bridge_error: { kind: "MT5_ERROR" } });
    const c = mk(recorder(503, errEnv("SYSTEM.TERMINAL_INFO", "LIVE", "MT5_ERROR", "TERMINAL_UNAVAILABLE")).f);
    const term = await c.getTerminal();
    expect(!term.ok && term.error.kind).toBe("MT5_ERROR");
    expect(c.health.snapshot()).toMatchObject({ transport_health: "HEALTHY", terminal_health: "DOWN" });
    const inv = await mk(recorder(400, errEnv("MARKET_DATA.BARS", "BACKFILL", "INVALID_REQUEST", "unsupported timeframe")).f)
      .getBars({ symbol: "XAUUSDm", timeframe: "M5", mode: "pos", start: 0, count: 1 });
    expect(!inv.ok && inv.error).toMatchObject({ kind: "INVALID_REQUEST", envelope: { request_id: "b".repeat(32) } });
  });
  it("HTTP protocol failure: non-2xx without envelope, and non-JSON error body", async () => {
    const a = await mk(recorder(404, { detail: "not found" }).f).getHealth();
    expect(!a.ok && a.error).toMatchObject({ kind: "HTTP_PROTOCOL_ERROR", http_status: 404 });
    const b = await mk(recorder(502, "<html>bad gateway</html>").f).getHealth();
    expect(!b.ok && b.error.kind).toBe("HTTP_PROTOCOL_ERROR");
  });
  it("HTTP 200 != valid broker response: malformed envelopes → CLIENT_PROTOCOL_ERROR and never enter the pipeline", async () => {
    const cases: Over[] = [
      { schema_version: "2.9" }, { request_id: "" }, { sequence: -1 }, { capability: "EXECUTION.ORDER" },
      { delivery: "BACKFILL" }, { timing: { source_event_at: T0, bridge_received_at: 5, bridge_sent_at: 1, client_sent_at: null, client_received_at: null } },
      { data: { ...tick(T0 + 7), raw_time_s: 1 } }, { extra_field: 1 },
    ];
    const clock = new ReplayClock(T0 + 20_000);
    const sunk: MarketEvent[] = [];
    const pipe = new BrokerFeedPipeline(SPEC, CFG, clock, (e) => sunk.push(e));
    const ingest = new GatewayMarketIngest(pipe, BIND);
    for (const o of cases) {
      const c = mk(recorder(200, { ...tickEnv(1, T0 + 7), ...o }).f);
      const r = await c.getLatestTick("XAUUSDm");
      expect(!r.ok && r.error.kind, JSON.stringify(o)).toBe("CLIENT_PROTOCOL_ERROR");
      for (const obs of c.tickObservations(r)) ingest.ingest(obs);
    }
    expect(pipe.audit).toHaveLength(0);
    expect(sunk).toHaveLength(0);
  });
});

// ---------------- Health ----------------
describe("2C health matrix", () => {
  const healthBody = (connected: boolean) => envelope("SYSTEM.HEALTH", "LIVE", { bridge_instance_id: "gw-u", connection_epoch: 0, source_mode: "SIMULATION", terminal_connected: connected });
  it("transport HEALTHY + gateway DEGRADED → system DEGRADED", async () => {
    const c = mk(recorder(404, { detail: "not found" }).f);
    await c.getHealth();
    expect(c.health.snapshot()).toMatchObject({ transport_health: "HEALTHY", gateway_health: "DEGRADED", terminal_health: "UNKNOWN", system_status: "DEGRADED", ...EXEC_INVARIANT });
  });
  it("transport HEALTHY + terminal DOWN → DEGRADED", async () => {
    const c = mk(recorder(200, healthBody(false)).f);
    await c.getHealth();
    expect(c.health.snapshot()).toMatchObject({ transport_health: "HEALTHY", gateway_health: "HEALTHY", terminal_health: "DOWN", market_data_freshness: "UNKNOWN", system_status: "DEGRADED", ...EXEC_INVARIANT });
  });
  it("transport DOWN → DOWN, downstream UNKNOWN (never HEALTHY)", async () => {
    const c = mk(async () => { throw new TypeError("refused"); });
    await c.probeHealth();
    expect(c.health.snapshot()).toMatchObject({ transport_health: "DOWN", gateway_health: "UNKNOWN", terminal_health: "UNKNOWN", market_data_freshness: "UNKNOWN", system_status: "DOWN", ...EXEC_INVARIANT });
  });
  it("all components healthy but no freshness policy → freshness UNKNOWN, system not HEALTHY", async () => {
    const c = mk(recorder(200, healthBody(true)).f);
    await c.getHealth();
    expect(c.health.snapshot()).toMatchObject({ market_data_freshness: "UNKNOWN", system_status: "UNKNOWN" });
  });
  it("FRESH/STALE only with explicit test policy; age is factual", () => {
    const ws = new FakeWs();
    const c = mk(recorder(200, {}).f, { wsFactory: () => ws, freshnessPolicy: new ExplicitFreshnessPolicy({ XAUUSDm: { max_tick_age_ms: 7 } }) });
    c.subscribeMarketData({ stream: "ticks", symbols: ["XAUUSDm"] }, { onTick() {} });
    ws.open();
    ws.push(tickEnv(1, T0 + 7));
    expect(c.health.snapshot()).toMatchObject({ market_data_freshness: "FRESH", last_tick_age_ms: 5 });
    expect(c.health.snapshot()).toMatchObject({ market_data_freshness: "STALE", last_tick_age_ms: 10, system_status: "DEGRADED" });
  });
  it("no health condition changes execution capability/authorization; no setter exists", async () => {
    const scenarios: FetchLike[] = [recorder(200, healthBody(true)).f, recorder(200, healthBody(false)).f, recorder(404, {}).f, recorder(200, "x").f, async () => { throw new Error(); }];
    for (const f of scenarios) {
      const c = mk(f);
      expect(c.health.snapshot()).toMatchObject(EXEC_INVARIANT);
      await c.probeHealth();
      expect(c.health.snapshot()).toMatchObject(EXEC_INVARIANT);
    }
    const src = readFileSync("src/core/broker/gateway/health.ts", "utf8");
    expect(src).not.toMatch(/"AVAILABLE"|"AUTHORIZED"/);
  });
});

// ---------------- WebSocket ----------------
class FakeWs implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  send(d: string) { this.sent.push(d); }
  close(code = 1000) { this.closed = true; this.onclose?.({ code }); }
  open() { this.onopen?.({}); }
  push(body: unknown) { this.onmessage?.({ data: typeof body === "string" ? body : JSON.stringify(body) }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}
function stream() {
  const ws = new FakeWs();
  const c = mk(recorder(200, {}).f, { wsFactory: () => ws });
  const ticks: ClientTickObservation[] = [];
  const errors: ClientError[] = [];
  const closes: (number | null)[] = [];
  const s = c.subscribeMarketData({ stream: "ticks", symbols: ["XAUUSDm"] }, { onTick: (o) => ticks.push(o), onError: (e) => errors.push(e), onClose: (i) => closes.push(i.code) });
  ws.open();
  return { ws, c, ticks, errors, closes, s };
}

describe("2C WebSocket matrix", () => {
  it("sends only the typed subscribe message", () => {
    const { ws } = stream();
    expect(ws.sent).toEqual([JSON.stringify({ action: "subscribe", stream: "ticks", symbols: ["XAUUSDm"] })]);
  });
  it("valid live events progress sequence; RTT null; apparent delay labeled cross-domain", () => {
    const { ws, ticks } = stream();
    ws.push(tickEnv(1, T0 + 7));
    ws.push(tickEnv(2, T0 + 1257, {}, 2345.2));
    expect(ticks.map((t) => t.sequence)).toEqual([1, 2]);
    expect(ticks.map((t) => t.sequence_disposition)).toEqual(["ACCEPT", "ACCEPT"]);
    for (const t of ticks) {
      expect(t.client_timing.transport_rtt_ms).toBeNull();
      expect(t.client_timing.client_sent_at).toBeNull();
      expect(t.delivery).toBe("LIVE");
    }
  });
  it("malformed WS envelope → CLIENT_PROTOCOL_ERROR, not delivered", () => {
    const { ws, ticks, errors } = stream();
    ws.push("not json");
    ws.push({ ...tickEnv(1, T0 + 7), schema_version: "x" });
    ws.push({ ...tickEnv(2, T0 + 7), capability: "SYSTEM.HEALTH" });
    expect(ticks).toHaveLength(0);
    expect(errors.map((e) => e.kind)).toEqual(["CLIENT_PROTOCOL_ERROR", "CLIENT_PROTOCOL_ERROR", "CLIENT_PROTOCOL_ERROR"]);
  });
  it("duplicate / regression → QUARANTINE; gap → ACCEPT_WITH_FLAG", () => {
    const { ws, ticks } = stream();
    ws.push(tickEnv(5, T0 + 7));
    ws.push(tickEnv(5, T0 + 8, {}, 2345.3));
    ws.push(tickEnv(4, T0 + 9, {}, 2345.4));
    ws.push(tickEnv(9, T0 + 10, {}, 2345.5));
    expect(ticks.map((t) => t.sequence_disposition)).toEqual(["ACCEPT", "QUARANTINE", "QUARANTINE", "ACCEPT_WITH_FLAG"]);
    expect(ticks[1]!.sequence_observations[0]!.kind).toBe("SEQUENCE_DUPLICATE");
    expect(ticks[2]!.sequence_observations[0]!.kind).toBe("SEQUENCE_REGRESSION");
    expect(ticks[3]!.sequence_observations[0]).toMatchObject({ kind: "SEQUENCE_GAP", missing: 3 });
  });
  it("gateway INVALID_REQUEST error envelope surfaces as INVALID_REQUEST", () => {
    const { ws, errors, ticks } = stream();
    ws.push(errEnv("MARKET_DATA.TICKS", "LIVE", "INVALID_REQUEST", "only stream=ticks is accepted"));
    expect(ticks).toHaveLength(0);
    expect(errors[0]!.kind).toBe("INVALID_REQUEST");
  });
  it("invalid subscriptions are rejected before any socket is created", () => {
    let created = 0;
    const c = mk(recorder(200, {}).f, { wsFactory: () => { created++; return new FakeWs(); } });
    const bad = [{ stream: "orders", symbols: ["X"] }, { stream: "ticks", symbols: [] }, { stream: "ticks", symbols: ["a b"] }, { stream: "ticks", symbols: Array(11).fill("X") }];
    for (const b of bad) expect(() => c.subscribeMarketData(b as never, { onTick() {} })).toThrow();
    expect(created).toBe(0);
  });
  it("disconnect: state CLOSED, onClose once, no health/authorization side effect", () => {
    const { ws, s, closes, c } = stream();
    expect(s.state).toBe("OPEN");
    const before = c.health.snapshot();
    ws.drop(1006);
    ws.drop(1006);
    expect(s.state).toBe("CLOSED");
    expect(closes).toEqual([1006]);
    expect(c.health.snapshot()).toEqual(before);
    const { ws: ws2, s: s2 } = stream();
    s2.close();
    expect(ws2.closed).toBe(true);
    expect(s2.state).toBe("CLOSED");
  });
  it("no generic command capability on client or stream handle", () => {
    const { s, c } = stream();
    const names = [...Object.getOwnPropertyNames(Object.getPrototypeOf(c)), ...Object.keys(s)];
    for (const n of names) expect(n).not.toMatch(/^(invoke|call|rpc|execute|command|request|send)$/i);
  });
});

// ---------------- Pipeline dispositions ----------------
const SPEC = { symbol: "XAUUSD", origin: "SYNTHETIC" as const, digits: 2, point: 0.01, tick_size: 0.01, contract_size: 100, broker_utc_offset_ms: 0 };
const CFG = { maxLatencyMs: 60_000, maxReorderMs: 60_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 120_000 }) };
const BIND = { broker_symbol: "XAUUSDm", canonical_symbol: "XAUUSD" };

describe("2C BrokerPipeline disposition matrix", () => {
  function rig() {
    const clock = new ReplayClock(T0 + 20_000);
    const agg = new CandleAggregator("XAUUSD", "M5", clock);
    const sunk: BrokerMarketEvent[] = [];
    const pipe = new BrokerFeedPipeline(SPEC, CFG, clock, (e) => { sunk.push(e); agg.ingest(e); });
    const ingest = new GatewayMarketIngest(pipe, BIND);
    const s = stream();
    return { ...s, ingest, sunk, agg, pipe };
  }
  it("ACCEPT, ACCEPT_WITH_FLAG, QUARANTINE, REJECT, and sequence-quarantine HELD", () => {
    const r = rig();
    r.ws.push(tickEnv(1, T0 + 2000, {}, 2345.1));                      // ACCEPT
    r.ws.push(tickEnv(2, T0 + 3000, { connection_epoch: 1 }, 2345.2)); // epoch change → RECONNECT_BACKFILL flag
    r.ws.push(tickEnv(3, T0 + 2500, { connection_epoch: 1 }, 2345.3)); // older event_at, open bucket → OUT_OF_ORDER QUARANTINE
    r.ws.push(tickEnv(4, T0 + 3000, { connection_epoch: 1 }, 2345.2)); // identical content → DUPLICATE REJECT
    r.ws.push(tickEnv(2, T0 + 4000, { connection_epoch: 1 }, 2345.9)); // sequence regression → client QUARANTINE
    const out = r.ticks.map((t) => r.ingest.ingest(t));
    expect(out.map((o) => (o.status === "FORWARDED" ? o.record.disposition : `HELD:${o.reason}`)))
      .toEqual(["ACCEPT", "ACCEPT_WITH_FLAG", "QUARANTINE", "REJECT", "HELD:SEQUENCE_QUARANTINE"]);
    // only ACCEPT / ACCEPT_WITH_FLAG reached the aggregator
    expect(r.sunk.map((e) => e.provenance.raw_event_id)).toEqual([r.ticks[0]!.raw_event_id, r.ticks[1]!.raw_event_id]);
    expect(r.agg.current?.tick_count).toBe(2);
    expect(r.pipe.quarantine.map((q) => q.envelope.raw.raw_event_id)).toEqual([r.ticks[2]!.raw_event_id]);
    expect(r.ingest.heldObservations).toHaveLength(1);
  });
  it("provenance preserved on the accepted path", () => {
    const r = rig();
    r.ws.push(tickEnv(1, T0 + 2000));
    const o = r.ticks[0]!;
    r.ingest.ingest(o);
    const tr = r.ingest.trace(o.raw_event_id)!;
    expect(tr.observation).toMatchObject({ bridge_instance_id: "gw-u", connection_epoch: 0, request_id: "r1", sequence: 1, source: "EXNESS_MT5", delivery: "LIVE" });
    expect(tr.observation.tick.raw_time_msc).toBe(T0 + 2000);
    expect(tr.observation.bridge_timing.bridge_received_at).toBe(T0 + 10_001);
    expect(tr.observation.client_timing.client_received_at).toBe(T0 + 20_000);
    expect(tr.audit!.envelope.raw.broker_time_ms).toBe(T0 + 2000);
    expect(tr.audit!.candidate.provenance).toMatchObject({ raw_event_id: o.raw_event_id, connection_epoch: 0, delivery: "STREAM", received_at: T0 + 10_001 });
    expect(r.sunk[0]!.event_at).toBe(T0 + 2000);
  });
});

// ---------------- Dashboard honesty ----------------
describe("2C dashboard", () => {
  const view = (state: GatewayHealthState) => render(<GatewayStatusView state={state} environment="FAKE_MT5_LOCAL" />);
  const text = (id: string) => screen.getByTestId(id).textContent;
  it("separate indicators + Fake MT5 label; terminal DOWN scenario", () => {
    view({ ...UNPROBED_STATE, transport_health: "HEALTHY", gateway_health: "HEALTHY", terminal_health: "DOWN", market_data_freshness: "STALE", last_tick_age_ms: 12, system_status: "DEGRADED", source_mode: "SIMULATION" });
    expect(text("gateway-env")).toBe("Fake MT5 / Local Gateway · SIMULATION");
    expect(text("gw-transport")).toBe("HEALTHY");
    expect(text("gw-gateway")).toBe("HEALTHY");
    expect(text("gw-mt5-terminal")).toBe("DOWN");
    expect(text("gw-market-data")).toMatch(/^STALE/);
    expect(text("gw-system")).toBe("DEGRADED");
    expect(text("gw-operating-mode")).toBe("MONITOR_ONLY");
    expect(text("gw-execution-capability")).toBe("ABSENT");
    expect(text("gw-execution-authorization")).toBe("DISABLED");
  });
  it("transport DOWN scenario renders UNKNOWN downstream, never HEALTHY or CONNECTED", () => {
    const { container } = view({ ...UNPROBED_STATE, transport_health: "DOWN", system_status: "DOWN" });
    expect([text("gw-transport"), text("gw-gateway"), text("gw-mt5-terminal"), text("gw-market-data"), text("gw-system")])
      .toEqual(["DOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "DOWN"]);
    expect(container.textContent).not.toMatch(/HEALTHY|CONNECTED|Exness Connected|Real MT5|Live Trading/i);
  });
  it("dashboard source makes no real-connection or live-trading claim", () => {
    for (const f of ["src/components/GatewayStatusPanel.tsx", "src/routes/index.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/Exness Connected|Real MT5 Connected|Live Trading/i);
    }
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
});
