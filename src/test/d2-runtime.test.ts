// D2 — hermetic APPLICATION-CHAIN tests. Everything enters through MarketRuntime's public boundary.
// The real BrokerGatewayClient (with real envelope validation + sequence tracking) runs over an injected
// hermetic transport (fetch + WebSocket fakes). This test never instantiates BootstrapCoordinator,
// AnomalyClassifier, BrokerFeedPipeline or LiveCandleFanout itself.
// G2: the fixture DECLARES its tick times as UTC ms and passes broker_utc_offset_ms = 0 explicitly. Not an Exness claim.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, TIMEFRAME_MS, type Timeframe } from "@/core/contracts";
import { BrokerGatewayClient, type FetchLike, type WebSocketLike } from "@/core/broker/gateway/BrokerGatewayClient";
import { makeGatewayConfig } from "@/core/broker/gateway/config";
import { MarketRuntime } from "@/core/runtime/MarketRuntime";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { probeRuntime } from "@/probe/technical/runtimeConsumer";
import { causalSwings } from "@/probe/technical/swing";
import { fromInternalBars } from "@/probe/technical/inputs";
import { ema } from "@/probe/technical/indicators";

const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const MIN = 60_000;
const SPEC = Object.freeze({ symbol: "XAUUSD", origin: "SYNTHETIC" as const, digits: 2, point: 0.01, tick_size: 0.01, contract_size: 100, broker_utc_offset_ms: 0 });
const CFG = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };

interface HT { ms: number; bid: number }
class FakeWS implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.onclose?.({ code: 1000 }); }
}

class HermeticTransport {
  epoch = 1;
  inst = "gw-hermetic";
  /** Mirrors vps/mt5_gateway/envelope.py: one counter per bridge instance, strictly increasing across epochs and channels. */
  private seq = 0;
  history: HT[] = [];
  coverage: "COMPLETE" | "PARTIAL" | "EMPTY" | "UNKNOWN" = "COMPLETE";
  historyFails = false;
  gate: Promise<void> | null = null;
  ws: FakeWS | null = null;
  requests: string[] = [];
  constructor(private readonly clock: ReplayClock) {}

  private next() { return ++this.seq; }
  private tick(t: HT) {
    return { broker_symbol: "XAUUSD", raw_time_s: Math.floor(t.ms / 1000), raw_time_msc: t.ms, time_precision: "ms", bid: t.bid, ask: +(t.bid + 0.2).toFixed(2), last: 0, volume: 0, flags: 6 };
  }
  private env(epoch: number, seq: number, capability: string, delivery: string, data: unknown, src: number | null, recv: number) {
    return {
      schema_version: "3.0B-1", bridge_instance_id: this.inst, connection_epoch: epoch, request_id: `r-${epoch}-${capability}-${seq}`, sequence: seq,
      delivery, source: "EXNESS_MT5", source_mode: "SIMULATION", capability,
      timing: { source_event_at: src, bridge_received_at: recv, bridge_sent_at: recv + 1, client_sent_at: null, client_received_at: null },
      latency: { source_arrival_delay_observed_ms: src === null ? null : recv - src, bridge_processing_ms: 1, bridge_to_client_apparent_delay_ms: null, transport_rtt_ms: null },
      ok: true, data, error: null,
    };
  }
  fetch: FetchLike = async (url) => {
    this.requests.push(url);
    const now = this.clock.now();
    const res = (b: unknown, status = 200) => ({ status, text: async () => JSON.stringify(b) });
    if (url.includes("/v1/health")) {
      return res(this.env(this.epoch, this.next(), "SYSTEM.HEALTH", "LIVE",
        { bridge_instance_id: this.inst, connection_epoch: this.epoch, source_mode: "SIMULATION", terminal_connected: true }, null, now - 2));
    }
    if (url.includes("/v1/ticks/XAUUSD")) {
      if (this.gate) await this.gate;
      if (this.historyFails) throw new TypeError("ECONNRESET");
      const q = new URL(url).searchParams;
      const from = Date.parse(q.get("from")!), to = Date.parse(q.get("to")!);
      const items = this.history.map((t) => this.tick(t));
      return res(this.env(this.epoch, this.next(), "MARKET_DATA.TICKS", "BACKFILL", {
        items, coverage: { requested_from: from, requested_to: to, returned_count: items.length,
          oldest_returned_at: items[0]?.raw_time_msc ?? null, newest_returned_at: items[items.length - 1]?.raw_time_msc ?? null,
          coverage_status: this.coverage, reason: null },
      }, null, this.clock.now() - 2));
    }
    return res({ hello: "not found" }, 404);
  };
  wsFactory = () => { this.ws = new FakeWS(); queueMicrotask(() => this.ws!.onopen?.({})); return this.ws; };
  /** LIVE stream tick. Bridge receives it 20ms after source time; canonical clock is advanced past that first. */
  live(t: HT, epoch = this.epoch) {
    if (this.clock.now() < t.ms + 30) this.clock.advanceTo(t.ms + 30);
    const e = this.env(epoch, this.next(), "MARKET_DATA.TICKS", "LIVE", this.tick(t), t.ms, t.ms + 20);
    this.ws!.onmessage!({ data: JSON.stringify(e) });
  }
}

function rig(maxBars = 500) {
  const clock = new ReplayClock(T0 + 10 * MIN);
  const tr = new HermeticTransport(clock);
  let mono = 0;
  const gateway = new BrokerGatewayClient({ config: makeGatewayConfig({}), wallClock: clock, monoClock: { now: () => (mono += 1) }, fetchImpl: tr.fetch, wsFactory: tr.wsFactory });
  const rt = new MarketRuntime({ gateway, clock, binding: { broker_symbol: "XAUUSD", canonical_symbol: "XAUUSD" }, spec: SPEC, classifier: CFG, maxClosedBarsPerTimeframe: maxBars });
  return { clock, tr, rt, r: rt.reader };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const REQ = { history_from: T0, history_to: T0 + 10 * MIN };
const HIST: HT[] = [{ ms: T0 + 1 * MIN, bid: 1000 }, { ms: T0 + 2 * MIN, bid: 1001 }, { ms: T0 + 9 * MIN, bid: 2000 }];

/** Full scenario: bootstrap with live-during-history + overlap, then ~9h of live every 2 min with a 30-minute hole. */
async function scenario() {
  const x = rig();
  x.tr.history = HIST;
  let release!: () => void;
  x.tr.gate = new Promise<void>((r) => { release = r; });
  const started = x.rt.start(REQ);
  await flush();
  const during = x.rt.bootstrapSnapshot().state;
  x.tr.live({ ms: T0 + 9 * MIN, bid: 2000 }); // overlaps a history tick (same content)
  x.tr.live({ ms: T0 + 9.5 * MIN, bid: 2000.5 });
  const bufferedDuring = x.rt.bootstrapSnapshot().buffered.length;
  const liveBeforeSync = x.r.snapshot().route_counts.LIVE_MUTATION;
  release();
  const state = await started;
  const holeFrom = T0 + 3 * 60 * MIN, holeTo = T0 + 3 * 60 * MIN + 30 * MIN;
  for (let ms = T0 + 10 * MIN; ms <= T0 + 9 * 60 * MIN; ms += 2 * MIN) {
    if (ms >= holeFrom && ms < holeTo) continue;
    x.tr.live({ ms, bid: +(2000 + 5 * Math.sin(ms / (37 * MIN)) + ((ms / MIN) % 7) * 0.3).toFixed(2) });
  }
  return { ...x, during, bufferedDuring, liveBeforeSync, state, holeFrom, holeTo };
}

describe("D2 canonical runtime — hermetic application chain", () => {
  it("1-8: startup, live buffered during bootstrap, history, backfill, overlap, drain, SYNCHRONIZED, subsequent live", async () => {
    const s = await scenario();
    expect(s.during).toBe("FETCHING_HISTORY");
    expect(s.bufferedDuring).toBe(2);
    expect(s.liveBeforeSync).toBe(0);
    expect(s.state).toBe("SYNCHRONIZED");
    const b = s.rt.archivedBootstraps.length ? s.rt.bootstrapSnapshot() : s.rt.bootstrapSnapshot();
    expect(b.transitions.map((t) => t.to)).toEqual(["BUFFERING_LIVE", "FETCHING_HISTORY", "REPLAYING_HISTORY", "DRAINING_BUFFER", "SYNCHRONIZED"]);
    const overlap = b.occurrences.find((o) => o.occurrence.delivery === "LIVE" && o.occurrence.source_event_ms === T0 + 9 * MIN)!;
    expect(overlap.identity.dedup_class).toBe("PROBABLE_SOURCE_DUPLICATE");
    expect(overlap.action).toBe("FORWARDED");
    const snap = s.r.snapshot();
    expect(snap.route_counts.BACKFILL_HISTORY).toBe(3);
    expect(snap.route_counts.LIVE_MUTATION).toBeGreaterThan(200);
    expect(snap.silent_ambiguous_drops).toBe(0);
    expect(snap.market_coverage_proven_complete).toBe(false);
    expect(s.tr.requests.some((u) => u.includes("/v1/ticks/XAUUSD?mode=range"))).toBe(true);
  });

  it("9+10: one LIVE observation fans out to independent M5/M15/H1/H4; canonical read snapshot is frozen", async () => {
    const s = await scenario();
    const snap = s.r.snapshot();
    const n = (tf: Timeframe) => snap.timeframes[tf].closed.length;
    expect(n("M5")).toBeGreaterThan(n("M15"));
    expect(n("M15")).toBeGreaterThan(n("H1"));
    expect(n("H1")).toBeGreaterThan(n("H4"));
    expect(n("H4")).toBeGreaterThanOrEqual(1);
    for (const tf of ["M5", "M15", "H1", "H4"] as const) {
      const c = snap.timeframes[tf].closed;
      expect(c.every((b) => b.status === "CLOSED" && b.timeframe === tf && b.close_time - b.open_time === TIMEFRAME_MS[tf])).toBe(true);
      expect(c.every((b) => b.closed_at! >= b.close_time)).toBe(true);
      expect(snap.timeframes[tf].forming?.status).toBe("FORMING");
      expect(Object.isFrozen(c)).toBe(true);
    }
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap).toMatchObject({ operating_mode: "MONITOR_ONLY", execution_enabled: false });
  });

  it("16: BACKFILL never mutates the live candle path (history bids 1000/1001 appear in no candle)", async () => {
    const s = await scenario();
    for (const tf of ["M5", "M15", "H1", "H4"] as const) {
      const all = [...s.r.closedBars(tf), s.r.formingBar(tf)!];
      expect(all.some((b) => b.low <= 1001)).toBe(false);
    }
    expect(s.rt.bootstrapSnapshot().live_frontier!.raw_event_id).toMatch(/^gw:gw-hermetic:e1:s\d+:i0$/);
  });

  it("17: late LIVE observation never rewrites a CLOSED candle", async () => {
    const s = await scenario();
    const before = JSON.stringify(s.r.closedBars("M5"));
    const lm = s.r.snapshot().route_counts.LIVE_MUTATION;
    s.tr.live({ ms: T0 + 60 * MIN, bid: 9999 }); // hours behind the live watermark
    expect(JSON.stringify(s.r.closedBars("M5"))).toBe(before);
    expect(s.r.snapshot().route_counts.LIVE_MUTATION).toBe(lm);
    for (const tf of ["M5", "M15", "H1", "H4"] as const) expect(s.r.snapshot().timeframes[tf].store.closed_canonical_mutations).toBe(0);
  });

  it("18: missing interval is explicit MissingInterval, never a fabricated candle", async () => {
    const s = await scenario();
    const closed = s.r.closedBars("M5");
    expect(closed.some((b) => b.open_time >= s.holeFrom && b.open_time < s.holeTo - 5 * MIN)).toBe(false);
    const mi = s.r.missingIntervals("M5").filter((m) => m.open_time >= s.holeFrom && m.open_time < s.holeTo);
    expect(mi.length).toBeGreaterThan(0);
    expect(mi.every((m) => m.kind === "MISSING_INTERVAL" && m.has_ohlc === false)).toBe(true);
  });

  it("13+14: epoch change degrades; rebootstrap keeps new-epoch observation; stale epoch never mutates", async () => {
    const s = await scenario();
    const t = T0 + 9 * 60 * MIN + 2 * MIN;
    s.tr.epoch = 2;
    s.tr.history = [];
    s.tr.coverage = "EMPTY";
    s.tr.live({ ms: t, bid: 2010 }, 2);
    expect(s.r.snapshot().bootstrap_state).toBe("DEGRADED");
    expect(s.r.snapshot().held.some((h) => h.reason === "AWAITING_REBOOTSTRAP" && h.connection_epoch === 2)).toBe(true);
    const lm = s.r.snapshot().route_counts.LIVE_MUTATION;
    const st = await s.rt.rebootstrap();
    expect(st).toBe("SYNCHRONIZED");
    expect(s.r.snapshot().active_epoch).toBe(2);
    expect(s.r.snapshot().route_counts.LIVE_MUTATION).toBe(lm + 1); // legitimate epoch-2 observation NOT discarded
    expect(s.rt.archivedBootstraps.length).toBeGreaterThanOrEqual(1);
    const formingBefore = JSON.stringify(s.r.formingBar("M5"));
    s.tr.live({ ms: t + MIN, bid: 3333 }, 1); // old epoch
    expect(s.r.snapshot().route_counts.LIVE_MUTATION).toBe(lm + 1);
    expect(JSON.stringify(s.r.formingBar("M5"))).toBe(formingBefore);
    s.tr.live({ ms: t + 2 * MIN, bid: 2011 }, 2);
    expect(s.r.snapshot().route_counts.LIVE_MUTATION).toBe(lm + 2);
  });

  it("15: degraded path — history fetch failure ends in DEGRADED, never SYNCHRONIZED; no live mutation", async () => {
    const x = rig();
    x.tr.historyFails = true;
    const st = await x.rt.start(REQ);
    expect(st).toBe("DEGRADED");
    expect(x.r.snapshot().degraded_reason).toMatch(/HISTORY_FETCH_FAILED: TRANSPORT_ERROR/);
    expect(x.r.snapshot().route_counts.LIVE_MUTATION).toBe(0);
  });

  it("15b: PARTIAL coverage is reported, never upgraded to proven completeness", async () => {
    const x = rig();
    x.tr.history = HIST;
    x.tr.coverage = "PARTIAL";
    await x.rt.start(REQ);
    expect(x.r.snapshot()).toMatchObject({ history_coverage_status: "PARTIAL", market_coverage_proven_complete: false });
  });

  it("protocol-invalid live message never reaches the pipeline", async () => {
    const x = rig();
    await x.rt.start(REQ);
    x.tr.ws!.onmessage!({ data: JSON.stringify({ schema_version: "3.0B-1", hello: 1 }) });
    expect(x.r.snapshot().route_counts.LIVE_MUTATION).toBe(0);
    // Surfaced, never hidden: the runtime exposes the protocol error count and last error.
    expect(x.r.snapshot().stream_protocol_errors).toBeGreaterThan(0);
    expect(x.r.snapshot().last_stream_error).toMatch(/CLIENT_PROTOCOL_ERROR/);
  });

  it("replay determinism: two runs of the same transport script give identical snapshots", async () => {
    const a = await scenario(), b = await scenario();
    expect(JSON.stringify(a.r.snapshot())).toBe(JSON.stringify(b.r.snapshot()));
  });
});

describe("Technical Probe v1b — application-wiring consumer of the runtime read model", () => {
  it("11: probe reads runtime CLOSED candles (not reconstructed test candles)", async () => {
    const s = await scenario();
    for (const tf of ["M5", "M15", "H1", "H4"] as const) {
      const p = probeRuntime(s.r, tf);
      expect(p.summary).toMatchObject({ kind: "DIAGNOSTIC_PROBE", authority: "NONE", source_mode: "APPLICATION_RUNTIME", usable_closed: s.r.closedBars(tf).length, excluded_forming: 1 });
      expect(p.ema5.result).toEqual(ema(fromInternalBars(s.r.closedBars(tf)), 5, tf));
      expect(p.summary.temporal_violations).toEqual([]);
    }
  });

  it("12: probe cannot mutate the runtime", async () => {
    const s = await scenario();
    const before = JSON.stringify(s.r.snapshot());
    for (const tf of ["M5", "M15", "H1", "H4"] as const) probeRuntime(s.r, tf);
    expect(JSON.stringify(s.r.snapshot())).toBe(before);
    expect(Object.keys(s.r).sort()).toEqual(["closedBars", "formingBar", "latestLiveObservation", "missingIntervals", "now", "snapshot", "symbol"]);
    expect(Object.isFrozen(s.r)).toBe(true);
    expect(Object.isFrozen(s.r.closedBars("M5")[0])).toBe(true);
  });

  it("forming M5/H1/H4 updates never change closed-only probe state; causal swings only from CLOSED confirmations", async () => {
    const s = await scenario();
    const run = () => (["M5", "H1", "H4"] as const).map((tf) => { const p = probeRuntime(s.r, tf); return JSON.stringify([p.ema5.result, p.ema21.result, p.atr14.result, p.swingCausal.result]); });
    const before = run();
    const last = s.r.formingBar("M5")!;
    s.tr.live({ ms: last.effective_at + 10_000, bid: 2500 }); // extreme value inside every forming bar
    expect(s.r.formingBar("H4")!.high).toBe(2500);
    expect(run()).toEqual(before);
    for (const c of causalSwings(fromInternalBars(s.r.closedBars("M15")), "M15").swings) expect(c.available_at).toBeGreaterThan(c.event_at);
  });
});

describe("D2 safety + isolation", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  it("MONITOR_ONLY, execution false, runtime has no execution surface, production never imports src/probe", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    const rt = readFileSync("src/core/runtime/MarketRuntime.ts", "utf8") + readFileSync("src/core/runtime/applicationRuntime.ts", "utf8");
    expect(rt).not.toMatch(/order_send|order_check|placeOrder|execute\(|positions_|account_/);
    expect(rt).not.toMatch(/broker_utc_offset_ms\s*[:=]\s*\d/);
    const prod = walk("src").filter((f) => !f.startsWith(join("src", "probe")) && !f.startsWith(join("src", "test")) && /\.(ts|tsx)$/.test(f));
    expect(prod.filter((f) => /from ["']@\/probe|from ["'].*\/probe\//.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
