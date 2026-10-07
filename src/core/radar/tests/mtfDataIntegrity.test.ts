// Phase 1 MTF foundation validation — Test 5 (runtime data integrity). Hermetic SIMULATION transport, not an Exness claim.
import { describe, expect, it } from "vitest";
import { BrokerGatewayClient, type FetchLike, type WebSocketLike } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { MarketRuntime } from "@/core/runtime/MarketRuntime";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";

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

import { RadarRuntimeService } from "@/core/radar/RadarRuntimeService";
import { TIMEFRAME_MS, type Bar, type Timeframe } from "@/core/contracts";

// Phase 1 · Test 5 — runtime data integrity (closed-candle discipline + bootstrap/live consistency).
const osc = (k: number) => +(2650 + 6 * Math.sin(k / 7) + 2.4 * Math.sin(k / 3) + (k % 5) * 0.12).toFixed(2);
const mkBar = (tf: Timeframe, i: number, status: Bar["status"] = "CLOSED"): Bar => {
  const ms = TIMEFRAME_MS[tf], o = osc(i), c = osc(i + 1);
  return Object.freeze<Bar>({ symbol: "XAUUSD", timeframe: tf, source: "EXNESS_MT5", open_time: T0 + i * ms, close_time: T0 + (i + 1) * ms,
    status, closed_at: T0 + (i + 1) * ms, effective_at: T0 + (i + 1) * ms, available_at: T0 + (i + 1) * ms,
    open: o, high: Math.max(o, c) + 0.8, low: Math.min(o, c) - 0.8, close: c, tick_count: 0, revision: 0 });
};
const series = (tf: Timeframe, endMs: number) => { const out: Bar[] = []; for (let i = 0; T0 + (i + 1) * TIMEFRAME_MS[tf] <= endMs; i++) out.push(mkBar(tf, i)); return out; };

describe("Phase 1 · Test 5 — runtime data integrity", () => {
  it("seedBrokerHistory keeps only bars with close_time <= broker/canonical now (forming bar dropped)", async () => {
    const x = await rig("XAUUSD");
    const now = x.clock.now(); // T0 + 10min
    const bars = Array.from({ length: 6 }, (_, i) => ({ open_time: T0 - 3 * 5 * MIN + i * 5 * MIN, open: 1, high: 2, low: 0, close: 1 }));
    // open times: T0-15, -10, -5, 0, +5 (closes at now ⇒ CLOSED), +10 (closes at +15 > now ⇒ FORMING)
    expect(x.rt.seedBrokerHistory("M5", bars)).toBe(5);
    expect(bars.at(-1)!.open_time + 5 * MIN).toBeGreaterThan(now);
  });

  it("historical bootstrap and live close on the same CLOSED evidence produce identical MTF reports", () => {
    const end = T0 + 40 * 4 * 3_600_000;
    const ev: Record<Timeframe, Bar[]> = { M5: series("M5", end), M15: series("M15", end), H1: series("H1", end), H4: series("H4", end) };
    const last = ev.M5.at(-1)!;
    const boot = new RadarRuntimeService("XAUUSD", { mode: "SYNTHETIC" });
    const live = new RadarRuntimeService("XAUUSD", { mode: "SYNTHETIC" });
    boot.bootstrapFromHistory(last, (tf) => ev[tf], end);
    live.onClosedM5(last, (tf) => ev[tf], end);
    expect(boot.snapshot()?.intelligence).toBeDefined();
    expect(JSON.stringify(boot.snapshot()!.intelligence)).toBe(JSON.stringify(live.snapshot()!.intelligence));
  });

  it("a FORMING bar (or one closing after the evaluated bar) never changes the report", () => {
    const end = T0 + 40 * 4 * 3_600_000;
    const ev: Record<Timeframe, Bar[]> = { M5: series("M5", end), M15: series("M15", end), H1: series("H1", end), H4: series("H4", end) };
    const last = ev.M5.at(-1)!;
    const clean = new RadarRuntimeService("XAUUSD", { mode: "SYNTHETIC" });
    clean.onClosedM5(last, (tf) => ev[tf], end);
    const dirty = new RadarRuntimeService("XAUUSD", { mode: "SYNTHETIC" });
    const spike = (tf: Timeframe) => { const n = ev[tf].length; return [...ev[tf], { ...mkBar(tf, n, "FORMING"), high: 9999, low: 1, close: 9999 }]; };
    dirty.onClosedM5(last, spike, end);
    expect(JSON.stringify(dirty.snapshot()!.intelligence)).toBe(JSON.stringify(clean.snapshot()!.intelligence));
    // a FORMING M5 is rejected outright as an evaluation trigger
    const f = new RadarRuntimeService("XAUUSD", { mode: "SYNTHETIC" });
    f.onClosedM5({ ...last, status: "FORMING" } as Bar, (tf) => ev[tf], end);
    expect(f.snapshot()).toBeNull();
  });
});
