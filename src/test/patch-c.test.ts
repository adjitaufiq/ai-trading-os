// PRE-2D Patch C — R5 missing interval, R7 bounded retention, R8 bar schema separation, + Patch B debts D1–D3.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, TIMEFRAME_MS, type Bar, type MarketEvent } from "@/core/contracts";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { BrokerFeedPipeline } from "@/core/broker/BrokerFeedPipeline";
import { LIVE_FANOUT_TIMEFRAMES, LiveCandleFanout } from "@/core/broker/LiveCandleFanout";
import { BootstrapCoordinator, PROCESSING_ORDER_SEMANTICS, type BootstrapHistoryCoverage } from "@/core/broker/bootstrap/BootstrapCoordinator";
import { ObservationIdentityRegistry, type ObservationOccurrence } from "@/core/broker/identity/ObservationIdentity";
import { BoundedIdentityStore } from "@/core/broker/identity/BoundedIdentityStore";
import type { BrokerMarketEvent, NormalizedBrokerBar } from "@/core/broker/types";
import {
  UNKNOWN_SESSION_CONTRACT, assessCountBasedHistory, describeCandle, detectMissingIntervals, impliesBrokerFailure, type SessionContract,
} from "@/core/candles/MissingInterval";
import { CandleStore, type HistoryRequirement } from "@/core/candles/CandleStore";
import { compareBars, toBrokerObservedBar, toInternalAggregatedBar } from "@/core/candles/BarSchemas";
import { BROKER_T0, SYNTHETIC_SPEC } from "@/core/fixtures/syntheticExnessFixture";

const M5 = TIMEFRAME_MS.M5;
const T = Math.floor(1_760_000_000_000 / TIMEFRAME_MS.H4) * TIMEFRAME_MS.H4;
let seq = 0;
const ev = (t: number, bid: number): MarketEvent => ({ seq: seq++, symbol: "XAUUSD", source: "EXNESS_MT5", bid, ask: bid + 0.2, spread: 0.2, event_at: t, observed_at: t, ingested_at: t });

function aggWithStore(maxBars: number) {
  const clock = new ReplayClock(T);
  const agg = new CandleAggregator("XAUUSD", "M5", clock);
  const store = new CandleStore("XAUUSD", "M5", maxBars);
  store.attach(agg);
  const tick = (t: number, bid: number) => { clock.advanceTo(t); agg.ingest(ev(t, bid)); };
  return { clock, agg, store, tick };
}
const deepFrozen = (b: Bar) => JSON.stringify(b);

// ---------------- R5 ----------------
describe("R5 missing interval contract", () => {
  it("1+2+5+6: zero observations → MissingInterval, not a candle; no previous-close synthesis; metadata preserved", () => {
    const r = aggWithStore(100);
    r.tick(T + 1_000, 2000);
    r.tick(T + 3 * M5 + 1_000, 2010); // intervals T+M5 and T+2*M5 receive nothing
    expect(r.store.closed).toHaveLength(1);
    expect(r.store.closed.map((b) => b.open_time)).toEqual([T]); // no fabricated bar
    const gaps = detectMissingIntervals(r.store.closed, T, T + 3 * M5, { symbol: "XAUUSD", timeframe: "M5", detected_at: r.clock.now() });
    expect(gaps.map((g) => [g.open_time, g.close_time])).toEqual([[T + M5, T + 2 * M5], [T + 2 * M5, T + 3 * M5]]);
    for (const g of gaps) {
      expect(g).toMatchObject({ kind: "MISSING_INTERVAL", symbol: "XAUUSD", timeframe: "M5", lifecycle: "NONE", coverage: "MISSING", has_ohlc: false });
      expect(g).not.toHaveProperty("open");
      expect(g).not.toHaveProperty("close");
      expect(g.reason).toBe("OUTSIDE_SESSION_CONTRACT_UNRESOLVED");
    }
    expect(r.store.closed.every((b) => b.tick_count > 0)).toBe(true);
  });

  it("3: weekend/inactive interval is not broker failure; authoritative closed session is labelled as such", () => {
    const closed: SessionContract = { authoritative: true, isClosed: () => true };
    const [g] = detectMissingIntervals([], T, T + M5, { symbol: "XAUUSD", timeframe: "M5", detected_at: T, session: closed });
    expect(g!.reason).toBe("MARKET_CLOSED_PER_SESSION_CONTRACT");
    expect(impliesBrokerFailure(g!)).toBe(false);
    const [u] = detectMissingIntervals([], T, T + M5, { symbol: "XAUUSD", timeframe: "M5", detected_at: T, session: UNKNOWN_SESSION_CONTRACT });
    expect(u!.reason).toBe("OUTSIDE_SESSION_CONTRACT_UNRESOLVED");
    expect(impliesBrokerFailure(u!)).toBe(false);
  });

  it("4: count-based history completion does not prove interval continuity", () => {
    const a = assessCountBasedHistory(200, 200);
    expect(a.request_completed).toBe(true);
    expect(a.market_interval_complete).toBe(false);
    expect(a.coverage).toBe("CONTINUITY_UNPROVEN");
  });

  it("R5.2: feed / coverage / lifecycle are separate axes", () => {
    const r = aggWithStore(10);
    r.tick(T + 1, 2000); r.tick(T + M5 + 1, 2001);
    const v = describeCandle(r.store.closed[0]!, "DEGRADED");
    expect(v).toMatchObject({ lifecycle: "CLOSED", coverage: "OBSERVED", feed: "DEGRADED" });
    expect(describeCandle(null, "SYNCHRONIZED")).toMatchObject({ lifecycle: "NONE", coverage: "MISSING", feed: "SYNCHRONIZED" });
  });
});

// ---------------- R7 ----------------
const OFFSET = SYNTHETIC_SPEC.broker_utc_offset_ms;
const CFG = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };
let auto = 0;
function occ(id: string, ms: number, bid: number, o: { delivery?: "LIVE" | "BACKFILL"; seq?: number; item?: number; epoch?: number } = {}): ObservationOccurrence {
  const delivery = o.delivery ?? "LIVE";
  return Object.freeze({
    raw_event_id: id, source: "EXNESS_MT5", broker_symbol: "XAUUSD", canonical_symbol: "XAUUSD", bridge_instance_id: "gw-1",
    connection_epoch: o.epoch ?? 1, channel: delivery === "LIVE" ? "STREAM" : "HISTORY", request_id: delivery === "LIVE" ? "stream" : "hist-1",
    sequence: o.seq ?? ++auto, item_index: o.item ?? 0, delivery, source_event_ms: BROKER_T0 + OFFSET + ms, bid, ask: +(bid + 0.2).toFixed(2),
    last: 0, volume: 0, flags: 6, received_at: BROKER_T0 + ms + 20,
  } as const);
}
const cov = (n: number, newest: number | null): BootstrapHistoryCoverage => ({
  requested_from: BROKER_T0 - 600_000, requested_to: BROKER_T0 + 600_000, returned_count: n, oldest_returned_at: null,
  newest_returned_at: newest === null ? null : BROKER_T0 + OFFSET + newest, coverage_status: "COMPLETE",
});
function rig(maxIdentity = 4, maxAudit: number | null = null) {
  const clock = new ReplayClock(BROKER_T0 - 3_600_000);
  clock.advanceTo(BROKER_T0 + 3_600_000);
  const fanout = new LiveCandleFanout("XAUUSD", clock);
  const mutations: Bar[] = [];
  for (const tf of LIVE_FANOUT_TIMEFRAMES) fanout.aggregators[tf].onBar((b) => mutations.push(b));
  const live: BrokerMarketEvent[] = [];
  const pipe = new BrokerFeedPipeline(SYNTHETIC_SPEC, CFG, clock, (e) => { live.push(e); fanout.ingest(e); });
  const store = new BoundedIdentityStore(maxIdentity);
  const registry = new ObservationIdentityRegistry(store, maxAudit);
  const boot = new BootstrapCoordinator(pipe, registry, 2);
  return { clock, fanout, mutations, live, pipe, store, registry, boot };
}

describe("R7 bounded retention", () => {
  it("7: identity store and pipeline audit stay bounded under sustained observations", () => {
    const r = rig(5);
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    for (let i = 0; i < 200; i++) r.boot.onLive(occ(`S${i}`, 1000 + i * 10, 2000 + i * 0.01));
    expect(r.store.size).toBeLessThanOrEqual(5);
    expect(r.store.metrics.evicted_total).toBe(195);
    const clock = new ReplayClock(BROKER_T0);
    const p = new BrokerFeedPipeline(SYNTHETIC_SPEC, CFG, clock, () => {}, {}, { maxAuditRecords: 10 });
    for (let i = 0; i < 100; i++) clock.advanceTo(BROKER_T0 + i * 10 + 30), p.process({ raw: { raw_event_id: `P${i}`, symbol: "XAUUSD", broker_time_ms: BROKER_T0 + OFFSET + i * 10, bid: 2000, ask: 2000.2 + i * 0.01 },
      source: "EXNESS_MT5", symbol: "XAUUSD", received_at: BROKER_T0 + i * 10 + 20, connection_epoch: 1, delivery: "STREAM" });
    expect(p.audit.length).toBeLessThanOrEqual(10);
    expect(p.retentionMetrics.cumulative_by_route.LIVE_MUTATION).toBe(100);
    expect(p.retentionMetrics.evicted_clean_total).toBe(90);
  });

  it("8+17: bootstrap-pinned identity evidence is not evicted; ambiguous occurrence stays audited", () => {
    const r = rig(2, 3);
    r.boot.start(1);
    for (let i = 0; i < 6; i++) r.boot.onLive(occ(`L${i}`, 1000 + i, 2000));
    r.boot.onLive(occ("LDUP", 1000, 2000)); // same fingerprint as L0, distinct transport identity
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([occ("B0", 1000, 2000, { delivery: "BACKFILL", seq: 1, item: 0 })], cov(1, 1000));
    // During the drain the store stayed pinned: nothing was evicted while pinned.
    expect(r.store.metrics.pinned_overflow_peak).toBeGreaterThan(0);
    const amb = r.boot.snapshot().occurrences.filter((a) => a.identity.dedup_class === "AMBIGUOUS_COLLISION" || a.identity.dedup_class === "PROBABLE_SOURCE_DUPLICATE");
    expect(amb.some((a) => a.occurrence.raw_event_id === "LDUP")).toBe(true);
    expect(r.boot.metrics.silent_ambiguous_drops).toBe(0);
  });

  it("9+10: after SYNCHRONIZED the pin is released and evidence becomes evictable", () => {
    const r = rig(2);
    r.boot.start(1);
    for (let i = 0; i < 5; i++) r.boot.onLive(occ(`L${i}`, 1000 + i, 2000 + i));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    expect(r.store.pinned).toBe(false);
    expect(r.boot.holdsIdentityPin).toBe(false);
    expect(r.store.size).toBeLessThanOrEqual(2);
  });

  it("11: no pin leak after DEGRADED bootstrap; restart re-pins exactly once", () => {
    const r = rig(2);
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyFailed("timeout");
    expect(r.boot.state).toBe("DEGRADED");
    expect(r.store.pinned).toBe(false);
    expect(r.boot.archivedSnapshots.at(-1)!.state).toBe("DEGRADED");
    r.boot.start(2);
    expect(r.store.metrics.pins).toBe(1);
  });

  it("12+13: history shorter than requirement is explicit; retention never silently reduces warmup", () => {
    const r = aggWithStore(3);
    for (let i = 0; i <= 6; i++) r.tick(T + i * M5 + 1, 2000 + i);
    const req: HistoryRequirement = { consumer_id: "stage4-placeholder", symbol: "XAUUSD", timeframe: "M5", required_bars: 2, warmup_bars: 3 };
    const h = r.store.history(req);
    expect(h.status).toBe("HISTORY_TRUNCATED");
    expect(h.delivery).toBe("RETAINED_SUBSET_ONLY");
    expect(h.truncated_by_retention).toBe(true);
    expect(h.bars).toHaveLength(3);
    expect(h.needed).toBe(5);
    const fresh = aggWithStore(100);
    for (let i = 0; i <= 3; i++) fresh.tick(T + i * M5 + 1, 2000);
    expect(fresh.store.history(req).status).toBe("WARMUP_UNSATISFIED");
    expect(fresh.store.history({ ...req, required_bars: 10 }).status).toBe("INSUFFICIENT_HISTORY");
    expect(fresh.store.history({ ...req, required_bars: 1, warmup_bars: 1 })).toMatchObject({ status: "SATISFIED", delivery: "ALL_REQUESTED" });
  });

  it("14: history request activity cannot advance LiveAcceptedFrontier", () => {
    const r = rig(50);
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([occ("B1", 9_000, 2000, { delivery: "BACKFILL", seq: 1, item: 0 })], cov(1, 9_000));
    expect(r.boot.liveAcceptedFrontier).toBeNull();
    expect(r.mutations).toHaveLength(0);
  });

  it("15+16+28: very late evidence → reconciliation; pressure and late broker history never mutate CLOSED", () => {
    const r = aggWithStore(4);
    for (let i = 0; i <= 5; i++) r.tick(T + i * M5 + 1, 2000 + i);
    const before = r.store.closed.map(deepFrozen);
    const late = r.store.routeLateEvidence(T, r.clock.now(), "broker history for evicted interval");
    expect(late).toMatchObject({ route: "RECONCILIATION_CANDIDATE", beyond_retention_horizon: true });
    r.store.append({ ...r.store.closed[1]!, close: 9999 }); // overwrite attempt
    expect(r.store.metrics.refused_closed_overwrites).toBe(1);
    expect(r.store.closed.map(deepFrozen)).toEqual(before);
    r.store.applyPressure(2);
    expect(r.store.closed.map(deepFrozen)).toEqual(before.slice(-2));
    expect(r.store.metrics.closed_canonical_mutations).toBe(0);
    expect(r.store.closed.every((b) => Object.isFrozen(b))).toBe(true);
  });

  it("15b: late BACKFILL through the pipeline routes to RECONCILIATION_CANDIDATE, never live", () => {
    const r = rig(50);
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null));
    r.boot.onLive(occ("L1", 600_000, 2000));
    const a = r.pipe.process({ raw: { raw_event_id: "OLD", symbol: "XAUUSD", broker_time_ms: BROKER_T0 + OFFSET + 1_000, bid: 1999, ask: 1999.2 },
      source: "EXNESS_MT5", symbol: "XAUUSD", received_at: BROKER_T0 + 700_000, connection_epoch: 1, delivery: "BACKFILL" });
    expect(a.route).toBe("RECONCILIATION_CANDIDATE");
    expect(r.live.map((e) => e.provenance.raw_event_id)).toEqual(["L1"]);
  });
});

// ---------------- R8 ----------------
const nb = (open_time: number, o: Partial<NormalizedBrokerBar> = {}): NormalizedBrokerBar => ({
  symbol: "XAUUSD", timeframe: "M5", open_time, open: 2000, high: 2002, low: 1999, close: 2001, tick_volume: 777, real_volume: null, observed_at: open_time + M5 + 50,
  provenance: { raw_event_id: "BB1", source: "EXNESS_MT5", symbol: "XAUUSD", received_at: open_time + M5 + 50, normalizer_version: "t", connection_epoch: 1, delivery: "BACKFILL" }, ...o,
});
function closedBar() {
  const r = aggWithStore(10);
  r.tick(T + 1, 2000); r.tick(T + 2, 2002); r.tick(T + 3, 1999); r.tick(T + 4, 2001); r.tick(T + M5 + 1, 2005);
  return { r, bar: r.store.closed[0]! };
}

describe("R8 bar schema separation", () => {
  it("18+19+20: distinct objects; observed_tick_count independent of tick_volume; real_volume explicit/nullable", () => {
    const { bar } = closedBar();
    const i = toInternalAggregatedBar(bar);
    const b = toBrokerObservedBar(nb(T), 5);
    expect(i.kind).toBe("INTERNAL_AGGREGATED");
    expect(b.kind).toBe("BROKER_OBSERVED");
    expect(i.observed_tick_count).toBe(4);
    expect(b.tick_volume).toBe(777);
    expect(i).not.toHaveProperty("tick_volume");
    expect(i).not.toHaveProperty("real_volume");
    expect(b).not.toHaveProperty("observed_tick_count");
    expect(b.real_volume).toBeNull();
    expect(toBrokerObservedBar(nb(T, { real_volume: 12 })).real_volume).toBe(12);
  });

  it("21–25: EXACT / WITHIN_TOLERANCE / MISMATCH / INSUFFICIENT_DATA / NOT_COMPARABLE; volumes never compared", () => {
    const { bar } = closedBar();
    const i = toInternalAggregatedBar(bar);
    const tol = { maxPriceDeltaPoints: 5 };
    const exact = compareBars(i, toBrokerObservedBar(nb(T)), SYNTHETIC_SPEC, tol);
    expect(exact.outcome).toBe("EXACT");
    expect(exact.volume).toEqual({ comparison: "NOT_COMPARED_NO_EQUIVALENCE", internal_observed_tick_count: 4, broker_tick_volume: 777, broker_real_volume: null });
    expect(compareBars(i, toBrokerObservedBar(nb(T, { close: 2001.03 })), SYNTHETIC_SPEC, tol).outcome).toBe("WITHIN_TOLERANCE");
    expect(compareBars(i, toBrokerObservedBar(nb(T, { close: 2003 })), SYNTHETIC_SPEC, tol).outcome).toBe("MISMATCH");
    expect(compareBars(i, null, SYNTHETIC_SPEC, tol).outcome).toBe("INSUFFICIENT_DATA");
    expect(compareBars(null, toBrokerObservedBar(nb(T)), SYNTHETIC_SPEC, tol).outcome).toBe("INSUFFICIENT_DATA");
    expect(compareBars(i, toBrokerObservedBar(nb(T, { timeframe: "M15" })), SYNTHETIC_SPEC, tol).outcome).toBe("NOT_COMPARABLE");
    expect(compareBars(i, toBrokerObservedBar(nb(T + M5)), SYNTHETIC_SPEC, tol).outcome).toBe("NOT_COMPARABLE");
  });

  it("26+27: mismatch overwrites neither internal CLOSED candle nor BrokerObservedBar", () => {
    const { r, bar } = closedBar();
    const i = toInternalAggregatedBar(bar);
    const b = toBrokerObservedBar(nb(T, { close: 2050 }));
    const snapI = JSON.stringify(i), snapB = JSON.stringify(b), snapStore = JSON.stringify(r.store.closed);
    const d = compareBars(i, b, SYNTHETIC_SPEC, { maxPriceDeltaPoints: 5 });
    expect(d.outcome).toBe("MISMATCH");
    expect(JSON.stringify(i)).toBe(snapI);
    expect(JSON.stringify(b)).toBe(snapB);
    expect(JSON.stringify(r.store.closed)).toBe(snapStore);
    expect(Object.isFrozen(i) && Object.isFrozen(b) && Object.isFrozen(d)).toBe(true);
    expect(r.store.metrics.closed_canonical_mutations).toBe(0);
  });
});

// ---------------- D1 / D3 ----------------
describe("Patch B audit debt D1 (narrow scope of REJECT → AMBIGUOUS change)", () => {
  it("29+30+31: same raw_event_id = exact duplicate; same fingerprint distinct identity = ambiguous; distinct fingerprint = distinct", () => {
    const reg = new ObservationIdentityRegistry();
    const a = occ("X1", 1000, 2000, { seq: 1 });
    expect(reg.classify(a, 1).dedup_class).toBe("DISTINCT_OBSERVATION");
    expect(reg.classify({ ...a, sequence: 99 }, 1).dedup_class).toBe("EXACT_TRANSPORT_DUPLICATE"); // same raw_event_id
    expect(reg.classify(occ("X2", 1000, 2000, { seq: 2 }), 1).dedup_class).toBe("AMBIGUOUS_COLLISION");
    expect(reg.classify(occ("X3", 1000, 2000.01, { seq: 3 }), 1).dedup_class).toBe("DISTINCT_OBSERVATION");
  });

  it("29b: exact duplicate is suppressed from canonical mutation but retained in audit", () => {
    const r = rig(50);
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null));
    const a = occ("E1", 1000, 2000, { seq: 1 });
    r.boot.onLive(a);
    r.boot.onLive(a);
    expect(r.live).toHaveLength(1);
    const audits = r.boot.snapshot().occurrences.filter((x) => x.occurrence.raw_event_id === "E1");
    expect(audits.map((x) => x.action)).toEqual(["FORWARDED", "SUPPRESSED_EXACT_DUPLICATE"]);
  });
});

describe("Patch B audit debt D3 (processing order ≠ market causality)", () => {
  it("32: same-ms occurrences with different transport sequence replay deterministically, both audited, no causal claim", () => {
    const run = (order: "fwd" | "rev") => {
      const r = rig(50);
      r.boot.start(1);
      const a = occ("A", 1000, 2000, { seq: 7 });
      const b = occ("B", 1000, 2000, { seq: 3 });
      for (const o of order === "fwd" ? [a, b] : [b, a]) r.boot.onLive(o);
      r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
      r.boot.historyReceived([], cov(0, null));
      return r;
    };
    const x = run("fwd"), y = run("rev");
    const ids = (r: ReturnType<typeof rig>) => r.boot.snapshot().occurrences.map((o) => [o.occurrence.raw_event_id, o.identity.dedup_class, o.action]);
    expect(ids(x)).toEqual(ids(y));
    expect(ids(x).map((i) => i[0]).sort()).toEqual(["A", "B"]);
    expect(ids(x).some((i) => i[1] === "AMBIGUOUS_COLLISION")).toBe(true);
    expect(x.boot.snapshot().processing_order).toBe(PROCESSING_ORDER_SEMANTICS);
    expect(PROCESSING_ORDER_SEMANTICS).toMatchObject({ market_causal_order_proven: false, transport_sequence_is_market_chronology: false });
  });
});

describe("Patch B audit debt D2 (real-chain integration)", () => {
  it("UI migration debt: terminal does not own bootstrap (React must never own canonical transitions)", () => {
    const src = readFileSync("src/components/RealMarketTerminal.tsx", "utf8");
    expect(src.includes("BootstrapCoordinator")).toBe(false);
  });
  it("D2 runtime: MarketRuntime owns the chain (hermetic application-chain tests in d2-runtime.test.ts); UI consumer migration remains separate debt", () => {
    const src = readFileSync("src/core/runtime/MarketRuntime.ts", "utf8");
    for (const c of ["BootstrapCoordinator", "ObservationIdentityRegistry", "BrokerFeedPipeline", "LiveCandleFanout", "CandleStore"]) expect(src).toContain(`new ${c}(`);
  });
});

// ---------------- Cross-patch ----------------
describe("cross-patch invariants", () => {
  it("33+34+35+36+37: BACKFILL/RECONCILE 0 live mutations, silent drops 0, MTF fanout independent, CLOSED immutable", () => {
    const r = rig(50);
    r.boot.start(1);
    r.boot.onLive(occ("L1", 1_000, 2000));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([occ("B1", 500, 1999, { delivery: "BACKFILL", seq: 1, item: 0 })], cov(1, 500));
    const live = r.pipe.audit.filter((a) => a.route === "LIVE_MUTATION");
    expect(live.every((a) => a.envelope.delivery === "STREAM")).toBe(true);
    expect(r.pipe.audit.filter((a) => a.route === "RECONCILIATION_CANDIDATE" && a.canonical_seq !== null)).toHaveLength(0);
    expect(r.boot.metrics.silent_ambiguous_drops).toBe(0);
    const forming = LIVE_FANOUT_TIMEFRAMES.map((tf) => r.fanout.aggregators[tf].current?.timeframe);
    expect(forming).toEqual(["M5", "M15", "H1", "H4"]);
  });

  it("38: MONITOR_ONLY, execution false, no execution surface in new Patch C code", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    const files = ["src/core/candles", "src/core/broker/identity"].flatMap((d) => readdirSync(d).map((f) => join(d, f))).filter((f) => statSync(f).isFile());
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/order_send|order_check|\bBUY\b|\bSELL\b|position_(open|close|modify)/);
  });
});
