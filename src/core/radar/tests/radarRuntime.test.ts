// Radar read model wired into MarketRuntime. Everything enters through the real BrokerGatewayClient over a
// hermetic transport (SIMULATION fixture, offset 0 declared explicitly — not an Exness claim).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrokerGatewayClient, type FetchLike, type WebSocketLike } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { MarketRuntime } from "@/core/runtime/MarketRuntime";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { RADAR_ALGORITHM_VERSIONS } from "../RadarRuntimeService";
import { RADAR_RECENT_EVENTS_MAX } from "../types";

const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // Monday
const MIN = 60_000;
const CFG = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };

class FakeWS implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send() {}
  close() { this.onclose?.({ code: 1000 }); }
}

class Transport {
  private seq = 0;
  ws: FakeWS | null = null;
  constructor(private readonly clock: ReplayClock, readonly sym: string, private readonly step: number) {}
  private tick(ms: number, bid: number) {
    return { broker_symbol: this.sym, raw_time_s: Math.floor(ms / 1000), raw_time_msc: ms, time_precision: "ms", bid, ask: +(bid + this.step).toFixed(2), last: 0, volume: 0, flags: 6 };
  }
  private env(capability: string, delivery: string, data: unknown, src: number | null, recv: number) {
    const seq = ++this.seq;
    return {
      schema_version: "3.0B-1", bridge_instance_id: `gw-${this.sym}`, connection_epoch: 1, request_id: `r-${seq}`, sequence: seq,
      delivery, source: "EXNESS_MT5", source_mode: "SIMULATION", capability,
      timing: { source_event_at: src, bridge_received_at: recv, bridge_sent_at: recv + 1, client_sent_at: null, client_received_at: null },
      latency: { source_arrival_delay_observed_ms: src === null ? null : recv - src, bridge_processing_ms: 1, bridge_to_client_apparent_delay_ms: null, transport_rtt_ms: null },
      ok: true, data, error: null,
    };
  }
  fetch: FetchLike = async (url) => {
    const now = this.clock.now();
    const res = (b: unknown, status = 200) => ({ status, text: async () => JSON.stringify(b) });
    if (url.includes("/v1/health")) return res(this.env("SYSTEM.HEALTH", "LIVE", { bridge_instance_id: `gw-${this.sym}`, connection_epoch: 1, source_mode: "SIMULATION", terminal_connected: true }, null, now - 2));
    if (url.includes(`/v1/ticks/${this.sym}`)) {
      const q = new URL(url).searchParams;
      return res(this.env("MARKET_DATA.TICKS", "BACKFILL", { items: [], coverage: { requested_from: Date.parse(q.get("from")!), requested_to: Date.parse(q.get("to")!), returned_count: 0, oldest_returned_at: null, newest_returned_at: null, coverage_status: "EMPTY", reason: null } }, null, now - 2));
    }
    return res({}, 404);
  };
  wsFactory = () => { this.ws = new FakeWS(); queueMicrotask(() => this.ws!.onopen?.({})); return this.ws; };
  live(ms: number, bid: number) {
    if (this.clock.now() < ms + 30) this.clock.advanceTo(ms + 30);
    this.ws!.onmessage!({ data: JSON.stringify(this.env("MARKET_DATA.TICKS", "LIVE", this.tick(ms, bid), ms, ms + 20)) });
  }
}

async function rig(sym: "XAUUSD" | "BTCUSD") {
  const clock = new ReplayClock(T0 + 10 * MIN);
  const point = sym === "XAUUSD" ? 0.01 : 0.01;
  const tr = new Transport(clock, sym, sym === "XAUUSD" ? 0.2 : 10);
  let mono = 0;
  const gateway = new BrokerGatewayClient({ config: makeGatewayConfig({}), wallClock: clock, monoClock: { now: () => (mono += 1) }, fetchImpl: tr.fetch, wsFactory: tr.wsFactory });
  const spec = Object.freeze({ symbol: sym, origin: "SYNTHETIC" as const, digits: 2, point, tick_size: point, contract_size: sym === "XAUUSD" ? 100 : 1, broker_utc_offset_ms: 0 });
  const rt = new MarketRuntime({ gateway, clock, binding: { broker_symbol: sym, canonical_symbol: sym }, spec, classifier: CFG, maxClosedBarsPerTimeframe: 500 });
  await rt.start({ history_from: T0, history_to: T0 + 10 * MIN });
  return { clock, tr, rt, r: rt.reader };
}

/** Deterministic oscillating path so swings/structure form. */
const price = (sym: string, k: number) => {
  const base = sym === "XAUUSD" ? 2650 : 65000, amp = sym === "XAUUSD" ? 6 : 150;
  return +(base + amp * Math.sin(k / 47) + amp * 0.4 * Math.sin(k / 9) + (k % 5) * amp * 0.02).toFixed(2);
};
const feed = (x: Awaited<ReturnType<typeof rig>>, from: number, to: number) => { for (let k = from; k < to; k++) x.tr.live(T0 + 10 * MIN + k * MIN, price(x.tr.sym, k)); };
const N = 30 * 60; // 30h of 1-minute ticks

describe("radar runtime read model", () => {
  it("evaluates only on CLOSED M5 bars; forming ticks never recompute", async () => {
    const x = await rig("XAUUSD");
    expect(x.r.radarSnapshot()).toBeNull();
    expect(x.r.radarHealth().status).toBe("INITIALIZING");
    feed(x, 0, N);
    const s1 = x.r.radarSnapshot()!;
    expect(s1).not.toBeNull();
    const last = s1.lastEvaluatedBarTime;
    // ticks inside the currently forming M5 bucket (no new close)
    const formingOpen = x.r.formingBar("M5")!.open_time;
    for (let i = 1; i <= 3; i++) x.tr.live(formingOpen + i * 1000 + 30 * MIN * 0, price("XAUUSD", N) + i * 0.01);
    expect(x.r.radarSnapshot()).toBe(s1); // same frozen object, no recalculation
    // the next close triggers exactly one new evaluation
    x.tr.live(formingOpen + 5 * MIN + 1000, price("XAUUSD", N + 6));
    const s2 = x.r.radarSnapshot()!;
    expect(s2).not.toBe(s1);
    expect(s2.lastEvaluatedBarTime).toBe(last + 5 * MIN);
  });

  it("schema: radar-v1, versions, health, frozen, bounded recent events, no score fields", async () => {
    const x = await rig("XAUUSD");
    feed(x, 0, N);
    const s = x.r.radarSnapshot()!;
    expect(s.schemaVersion).toBe("radar-v1");
    expect(s.algorithmVersions).toEqual(RADAR_ALGORITHM_VERSIONS);
    expect(s).toMatchObject({ symbol: "XAUUSD", assetClass: "COMMODITY", validationSource: { mode: "SYNTHETIC" } });
    expect(x.r.radarHealth()).toMatchObject({ status: "ACTIVE", validationMode: "SYNTHETIC" });
    expect(s.recentEvents.length).toBeLessThanOrEqual(RADAR_RECENT_EVENTS_MAX);
    expect(Object.isFrozen(s) && Object.isFrozen(s.footprints.activeTags) && Object.isFrozen(s.regime)).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/confidence|probability|score/i);
    x.clock.advanceTo(x.clock.now() + 11 * MIN);
    expect(x.r.radarHealth().status).toBe("STALE");
  });

  it("parallel BTC + XAU runtimes stay byte-identical to isolated runs", async () => {
    const [xa, ba] = [await rig("XAUUSD"), await rig("BTCUSD")];
    feed(xa, 0, N); feed(ba, 0, N);
    const [xp, bp] = [await rig("XAUUSD"), await rig("BTCUSD")];
    for (let k = 0; k < N; k++) { feed(bp, k, k + 1); feed(xp, k, k + 1); } // interleaved live streams
    expect(JSON.stringify(xp.r.radarSnapshot())).toBe(JSON.stringify(xa.r.radarSnapshot()));
    expect(JSON.stringify(bp.r.radarSnapshot())).toBe(JSON.stringify(ba.r.radarSnapshot()));
    expect(bp.r.radarSnapshot()!.assetClass).toBe("CRYPTO");
    // BTC data never mutates XAU's snapshot
    const xs = xp.r.radarSnapshot();
    feed(bp, N, N + 60);
    expect(xp.r.radarSnapshot()).toBe(xs);
    expect(bp.r.radarSnapshot()).not.toBe(ba.r.radarSnapshot());
    for (const e of [...xs!.activeEvents, ...xs!.recentEvents]) expect(e.eventId).not.toContain("BTCUSD");
  });

  it("radar module never imports signal/plan/risk/execution", () => {
    for (const f of ["RadarRuntimeService.ts", "types.ts"]) {
      const src = readFileSync(`src/core/radar/${f}`, "utf8");
      expect(src).not.toMatch(/engine\/(signal|plan|risk|execution)|order_send|placeOrder/);
    }
  });
});
