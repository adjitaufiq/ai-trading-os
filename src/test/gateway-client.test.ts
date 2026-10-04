import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerGatewayClient, type FetchLike } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { ExplicitFreshnessPolicy } from "@/core/broker/gateway/health";
import { SequenceTracker } from "@/core/broker/gateway/SequenceTracker";
import { GatewayMarketIngest } from "@/core/broker/gateway/GatewayMarketIngest";
import { validateEnvelope } from "@/core/broker/gateway/validate";
import { BrokerFeedPipeline } from "@/core/broker/BrokerFeedPipeline";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { EXECUTION_ENABLED, OPERATING_MODE, type MarketEvent } from "@/core/contracts";
import type { ClientTickObservation } from "@/core/broker/gateway/types";

const T0 = Date.UTC(2026, 0, 5, 8, 0, 0);
const mono = () => { let t = 0; return { now: () => (t += 5) }; };
const env = (o: Record<string, unknown> = {}) => ({
  schema_version: "3.0B-1", bridge_instance_id: "gw-x", connection_epoch: 0, request_id: "a".repeat(32), sequence: 1,
  delivery: "LIVE", source: "EXNESS_MT5", source_mode: "SIMULATION", capability: "SYSTEM.HEALTH",
  timing: { source_event_at: null, bridge_received_at: 100, bridge_sent_at: 102, client_sent_at: null, client_received_at: null },
  latency: { source_arrival_delay_observed_ms: null, bridge_processing_ms: 2, bridge_to_client_apparent_delay_ms: null, transport_rtt_ms: null },
  ok: true, data: { bridge_instance_id: "gw-x", connection_epoch: 0, source_mode: "SIMULATION", terminal_connected: false }, error: null, ...o,
});
const fakeFetch = (status: number, body: unknown): FetchLike => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const client = (f: FetchLike, timeoutMs = 1000) =>
  new BrokerGatewayClient({ config: makeGatewayConfig({ timeoutMs }), wallClock: new ReplayClock(T0), monoClock: mono(), fetchImpl: f });

describe("2C envelope validation + health (unit)", () => {
  it("valid envelope accepted; wrong schema / missing request id / bad sequence rejected", () => {
    expect(validateEnvelope(env(), "HEALTH").ok).toBe(true);
    expect(validateEnvelope(env({ schema_version: "9" }), "HEALTH").ok).toBe(false);
    expect(validateEnvelope(env({ request_id: "" }), "HEALTH").ok).toBe(false);
    expect(validateEnvelope(env({ sequence: 0 }), "HEALTH").ok).toBe(false);
  });
  it("transport healthy + terminal down → system DEGRADED, freshness UNKNOWN, execution ABSENT/DISABLED", async () => {
    const c = client(fakeFetch(200, env()));
    await c.getHealth();
    expect(c.health.snapshot()).toMatchObject({ transport_health: "HEALTHY", gateway_health: "HEALTHY", terminal_health: "DOWN",
      market_data_freshness: "UNKNOWN", system_status: "DEGRADED", execution_capability: "ABSENT", execution_authorization: "DISABLED" });
  });
  it("transport down → DOWN/UNKNOWN/UNKNOWN; malformed 200 → CLIENT_PROTOCOL_ERROR; timeout", async () => {
    const down = client(async () => { throw new TypeError("ECONNREFUSED"); });
    const r = await down.getHealth();
    expect(!r.ok && r.error.kind).toBe("TRANSPORT_ERROR");
    expect(down.health.snapshot()).toMatchObject({ transport_health: "DOWN", gateway_health: "UNKNOWN", terminal_health: "UNKNOWN", system_status: "DOWN" });
    const bad = await client(fakeFetch(200, { hello: 1 })).getHealth();
    expect(!bad.ok && bad.error.kind).toBe("CLIENT_PROTOCOL_ERROR");
    const hang: FetchLike = (_u, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(new Error("abort"))));
    const to = await client(hang, 20).getHealth();
    expect(!to.ok && to.error.kind).toBe("TIMEOUT");
  });
  it("RTT from monotonic clock; no network-latency field", async () => {
    const r = await client(fakeFetch(200, env())).getHealth();
    expect(r.ok && r.timing.transport_rtt_ms).toBe(5);
    expect(JSON.stringify(r)).not.toMatch(/network_latency/);
  });
  it("sequence duplicate / regression / gap / epoch regression / instance change", () => {
    const t = new SequenceTracker();
    const m = (s: number, e = 1, i = "a") => ({ bridge_instance_id: i, connection_epoch: e, sequence: s });
    t.track("STREAM", m(5));
    expect(t.track("STREAM", m(5)).observations[0]!.kind).toBe("SEQUENCE_DUPLICATE");
    expect(t.track("STREAM", m(3)).disposition).toBe("QUARANTINE");
    expect(t.track("STREAM", m(8)).observations[0]).toMatchObject({ kind: "SEQUENCE_GAP", missing: 2 });
    expect(t.track("STREAM", m(9, 0)).observations[0]!.kind).toBe("EPOCH_REGRESSION");
    expect(t.track("STREAM", m(1, 0, "b")).observations[0]!.kind).toBe("BRIDGE_INSTANCE_CHANGE");
  });
  it("config rejects credentials in URL", () => {
    expect(() => makeGatewayConfig({ httpBaseUrl: "http://u:p@127.0.0.1:8000" })).toThrow();
  });
});

describe("2C hermetic full chain: FakeMT5 → adapter → 2B gateway → HTTP/WS → client → BrokerPipeline", () => {
  let proc: ChildProcess; let port = 0;
  beforeAll(async () => {
    proc = spawn("python3", ["vps/tests/serve_fake_gateway.py"], { stdio: ["pipe", "pipe", "inherit"] });
    const rl = createInterface({ input: proc.stdout! });
    port = await new Promise<number>((res) => rl.once("line", (l) => res(JSON.parse(l).port)));
  });
  afterAll(() => { proc.stdin!.end(); });
  const live = (fp?: ExplicitFreshnessPolicy) => new BrokerGatewayClient({
    config: makeGatewayConfig({ httpBaseUrl: `http://127.0.0.1:${port}`, wsBaseUrl: `ws://127.0.0.1:${port}` }),
    wallClock: new ReplayClock(T0 + 20_000), monoClock: mono(), freshnessPolicy: fp,
    wsFactory: (u) => new WebSocket(u) as never,
  });

  it("HTTP routes return validated envelopes; health decomposed honestly", async () => {
    const c = live();
    const s = await c.probeHealth();
    expect(s).toMatchObject({ transport_health: "HEALTHY", gateway_health: "HEALTHY", terminal_health: "HEALTHY", source_mode: "SIMULATION",
      execution_capability: "ABSENT", execution_authorization: "DISABLED", market_data_freshness: "UNKNOWN" });
    const syms = await c.getSymbols("XAU*");
    expect(syms.ok && syms.data.map((x) => x.broker_symbol)).toEqual(["XAUUSDm", "XAUUSDz"]);
    const bars = await c.getBars({ symbol: "XAUUSDm", timeframe: "M5", mode: "range", from: T0, to: T0 + 15 * 60_000 });
    expect(bars.ok && bars.envelope.delivery).toBe("BACKFILL");
    const ticks = await c.getTicks({ symbol: "XAUUSDm", mode: "range", from: T0, to: T0 + 60_000 });
    expect(ticks.ok && ticks.data.coverage.coverage_status).not.toBe("COMPLETE");
    const nf = await c.getSymbol("NOPE");
    expect(!nf.ok && nf.error.kind).toBe("NOT_FOUND");
    expect(c.protocolErrors).toEqual([]);
  });

  it("WS LIVE tick traverses into BrokerPipeline → CandleAggregator with provenance", async () => {
    const c = live(new ExplicitFreshnessPolicy({ XAUUSDm: { max_tick_age_ms: 1 } }));
    const clock = new ReplayClock(T0 + 20_000);
    const agg = new CandleAggregator("XAUUSD", "M5", clock);
    const sunk: MarketEvent[] = [];
    const pipe = new BrokerFeedPipeline(
      { symbol: "XAUUSD", origin: "SYNTHETIC", digits: 2, point: 0.01, tick_size: 0.01, contract_size: 100, broker_utc_offset_ms: 0 },
      { maxLatencyMs: 60_000, maxReorderMs: 60_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 120_000 }) },
      clock, (e) => { sunk.push(e); agg.ingest(e); });
    const ingest = new GatewayMarketIngest(pipe, { broker_symbol: "XAUUSDm", canonical_symbol: "XAUUSD" });
    const obs = await new Promise<ClientTickObservation>((res, rej) => {
      const s = c.subscribeMarketData({ stream: "ticks", symbols: ["XAUUSDm"] }, { onTick: (o) => { s.close(); res(o); }, onError: (e) => rej(e) });
    });
    expect(obs.delivery).toBe("LIVE");
    expect(obs.client_timing.transport_rtt_ms).toBeNull();
    expect(obs.bridge_timing.source_event_at).toBe(obs.tick.raw_time_msc);
    const out = ingest.ingest(obs);
    expect(out.status === "FORWARDED" && out.record.disposition).toBe("ACCEPT");
    expect(sunk).toHaveLength(1);
    const tr = ingest.trace(obs.raw_event_id)!;
    expect(tr.observation).toMatchObject({ bridge_instance_id: "gw-e2e", request_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(tr.audit!.candidate.provenance.raw_event_id).toBe(obs.raw_event_id);
    expect(c.health.snapshot().market_data_freshness).toBe("STALE"); // explicit test policy only
    // quarantined observation never reaches the aggregator
    expect(ingest.ingest({ ...obs, sequence_disposition: "QUARANTINE" }).status).toBe("HELD");
    expect(sunk).toHaveLength(1);
  });

  it("invalid subscription rejected client-side", () => {
    expect(() => live().subscribeMarketData({ stream: "orders" as "ticks", symbols: ["X"] }, { onTick() {} })).toThrow();
  });
});

describe("2C safety", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  it("no execution/account/position/RPC/credential surface; no direct aggregator bypass", () => {
    for (const f of walk("src/core/broker/gateway")) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/order_send|order_check|account_info|positions_get|MetaTrader5|invoke\(|rpc\(|execute\(|password\s*[:=]|login\(|import[^;]*CandleAggregator|Date\.now\(/);
    }
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
});
