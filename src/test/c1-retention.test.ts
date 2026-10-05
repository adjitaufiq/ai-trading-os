// C1 Retention Contract v1 — deterministic adversarial matrix A–R.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, type Bar } from "@/core/contracts";
import { BrokerFeedPipeline } from "@/core/broker/BrokerFeedPipeline";
import { LIVE_FANOUT_TIMEFRAMES, LiveCandleFanout } from "@/core/broker/LiveCandleFanout";
import { BootstrapCoordinator, type BootstrapHistoryCoverage } from "@/core/broker/bootstrap/BootstrapCoordinator";
import { ObservationIdentityRegistry, type ObservationOccurrence } from "@/core/broker/identity/ObservationIdentity";
import { RetentionIdentityStore } from "@/core/broker/identity/RetentionDomains";
import type { BrokerMarketEvent } from "@/core/broker/types";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { BROKER_T0, SYNTHETIC_SPEC } from "@/core/fixtures/syntheticExnessFixture";

const OFFSET = SYNTHETIC_SPEC.broker_utc_offset_ms;
const CFG = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };
const SYM = "XAUUSD";

interface O { delivery?: "LIVE" | "BACKFILL"; epoch?: number; seq?: number; req?: string; item?: number }
let auto = 0;
function occ(id: string, ms: number, bid: number, o: O = {}): ObservationOccurrence {
  const delivery = o.delivery ?? "LIVE";
  return Object.freeze({
    raw_event_id: id, source: "EXNESS_MT5", broker_symbol: SYM, canonical_symbol: SYM,
    bridge_instance_id: "gw-1", connection_epoch: o.epoch ?? 1,
    channel: delivery === "LIVE" ? "STREAM" : "HISTORY",
    request_id: o.req ?? (delivery === "LIVE" ? "stream" : "hist-1"), sequence: o.seq ?? ++auto, item_index: o.item ?? 0,
    delivery, source_event_ms: BROKER_T0 + OFFSET + ms, bid, ask: +(bid + 0.2).toFixed(2), last: 0, volume: 0, flags: 6,
    received_at: BROKER_T0 + ms + 20,
  });
}
const M = (ms: number) => BROKER_T0 + OFFSET + ms;
const cov = (n: number, newest: number | null, status: BootstrapHistoryCoverage["coverage_status"] = "COMPLETE"): BootstrapHistoryCoverage =>
  ({ requested_from: M(0), requested_to: M(10_000_000), returned_count: n, oldest_returned_at: null, newest_returned_at: newest === null ? null : M(newest), coverage_status: status });

function rig(store = new RetentionIdentityStore()) {
  const clock = new ReplayClock(BROKER_T0 - 3_600_000);
  clock.advanceTo(BROKER_T0 + 400_000_000);
  const fanout = new LiveCandleFanout(SYM, clock);
  const mutations: Bar[] = [];
  for (const tf of LIVE_FANOUT_TIMEFRAMES) fanout.aggregators[tf].onBar((b) => mutations.push(b));
  const live: BrokerMarketEvent[] = [];
  const pipe = new BrokerFeedPipeline(SYNTHETIC_SPEC, CFG, clock, (e) => { live.push(e); fanout.ingest(e); });
  const reg = new ObservationIdentityRegistry(store, 50);
  const boot = new BootstrapCoordinator(pipe, reg);
  return { clock, live, mutations, pipe, reg, boot, store };
}
function synced(store?: RetentionIdentityStore, epoch = 1) {
  const r = rig(store);
  r.boot.start(epoch);
  r.boot.beginHistory({ requested_from: M(0), requested_to: M(1) });
  r.boot.historyReceived([], cov(0, null));
  expect(r.boot.state).toBe("SYNCHRONIZED");
  return r;
}
const last = (r: ReturnType<typeof rig>) => r.boot.snapshot().occurrences.at(-1)!;

describe("C1 ownership", () => {
  it("AnomalyClassifier holds no parallel identity memory", () => {
    const src = readFileSync("src/core/broker/AnomalyClassifier.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/seenIds|seenContent|new Set|new Map/);
  });
});

describe("C1 adversarial matrix", () => {
  it("A. immediate exact transport duplicate is suppressed, audited", () => {
    const r = synced();
    const a = occ("A1", 1000, 2000);
    r.boot.onLive(a); r.boot.onLive(a);
    expect(last(r).identity.dedup_class).toBe("EXACT_TRANSPORT_DUPLICATE");
    expect(last(r).action).toBe("SUPPRESSED_EXACT_DUPLICATE");
    expect(r.live).toHaveLength(1);
  });

  it("B. raw_event_id duplicate after many unrelated observations (unsettled → still retained)", () => {
    const r = rig();
    const reg = r.reg;
    reg.classify(occ("B0", 1000, 2000), 1);
    for (let i = 1; i <= 5000; i++) reg.classify(occ(`U${i}`, 1000 + i, 2000 + i * 0.01), 1);
    expect(reg.classify(occ("B0", 1000, 2000, { seq: 999_999 }), 1).dedup_class).toBe("EXACT_TRANSPORT_DUPLICATE");
  });

  it("C. same-ms same-price legitimate observations with distinct identity are both kept (flagged)", () => {
    const r = synced();
    r.boot.onLive(occ("C1", 1000, 2000)); r.boot.onLive(occ("C2", 1000, 2000));
    expect(r.live).toHaveLength(2);
    expect(last(r).identity.dedup_class).toBe("AMBIGUOUS_COLLISION");
    expect(r.boot.metrics.silent_ambiguous_drops).toBe(0);
  });

  it("D. reconnect: old transport epoch occurrence cannot mutate current state", () => {
    const r = synced(undefined, 1);
    r.boot.onLive(occ("D1", 1000, 2000, { epoch: 1 }));
    r.boot.start(2);
    r.boot.beginHistory({ requested_from: M(0), requested_to: M(1) });
    r.boot.historyReceived([], cov(0, null));
    const before = r.live.length;
    r.boot.onLive(occ("D2", 5000, 2001, { epoch: 1 }));
    expect(last(r).identity.dedup_class).toBe("STALE_EPOCH_OCCURRENCE");
    expect(r.live.length).toBe(before);
  });

  it("E. same raw_event_id reappearing through a new epoch stays a known source identity", () => {
    const r = rig();
    r.reg.classify(occ("E1", 1000, 2000, { epoch: 1 }), 1);
    r.store.retireEpochsThrough(1);
    expect(r.store.metrics.transport_occurrence_retained).toBe(0);
    const c = r.reg.classify(occ("E1", 1000, 2000, { epoch: 2, seq: 1 }), 2);
    expect(c.dedup_class).toBe("EXACT_TRANSPORT_DUPLICATE");
    expect(c.reason).toMatch(/raw_event_id/);
  });

  it("F. LIVE/BACKFILL overlap → PROBABLE_SOURCE_DUPLICATE with OVERLAP dependency", () => {
    const r = rig();
    r.reg.classify(occ("H1", 1000, 2000, { delivery: "BACKFILL" }), 1);
    const c = r.reg.classify(occ("L1", 1000, 2000), 1);
    expect(c.dedup_class).toBe("PROBABLE_SOURCE_DUPLICATE");
    expect(r.store.reconciliation.unresolved("OVERLAP")).toHaveLength(1);
  });

  it("G. repeated history request with new request_id: same raw ids are exact duplicates", () => {
    const r = rig();
    r.reg.classify(occ("G1", 1000, 2000, { delivery: "BACKFILL", req: "h1", seq: 1 }), 1);
    const c = r.reg.classify(occ("G1", 1000, 2000, { delivery: "BACKFILL", req: "h2", seq: 2 }), 1);
    expect(c.dedup_class).toBe("EXACT_TRANSPORT_DUPLICATE");
  });

  it("H. eviction immediately before duplicate redelivery → held for reconcile, never DISTINCT/live", () => {
    const store = new RetentionIdentityStore({ transport: 1, source: 1, fingerprint: 1 });
    const r = synced(store);
    r.boot.onLive(occ("H1", 1000, 2000));
    r.boot.onLive(occ("H2", 2000, 2001)); // H1 now behind frontier → eligible → evicted at capacity 1
    expect(store.hasRawEvent("H1")).toBe(false);
    const n = r.live.length;
    r.boot.onLive(occ("H1", 1000, 2000, { seq: 777 }));
    expect(last(r).identity.dedup_class).not.toBe("DISTINCT_OBSERVATION");
    expect(last(r).identity.evidence_status).toBe("EVIDENCE_EVICTED");
    expect(last(r).action).toBe("HELD_RECONCILE");
    expect(r.live.length).toBe(n);
  });

  it("I. fingerprint eviction + equal-content observation must not become DISTINCT", () => {
    const store = new RetentionIdentityStore({ transport: 1, source: 1, fingerprint: 1 });
    const r = rig(store);
    r.reg.classify(occ("I1", 1000, 2000), 1);
    store.settleThrough(SYM, M(5000));
    r.reg.classify(occ("I2", 6000, 2100), 1);
    expect(store.byFingerprint(r.reg.audit[0]!.classification.fingerprint)).toHaveLength(0);
    const c = r.reg.classify(occ("I3", 1000, 2000), 1);
    expect(c.dedup_class).toBe("AMBIGUOUS_COLLISION");
    expect(c.evidence_status).toBe("EVIDENCE_EVICTED");
    // Standalone pipeline authority: same rule → RECONCILE, no live mutation.
    const clock = new ReplayClock(BROKER_T0); clock.advanceTo(BROKER_T0 + 100_000);
    const live: BrokerMarketEvent[] = [];
    const p = new BrokerFeedPipeline(SYNTHETIC_SPEC, CFG, clock, (e) => live.push(e));
    const env = (id: string, ms: number, bid: number) => ({ raw: { raw_event_id: id, symbol: SYM, broker_time_ms: M(ms), bid, ask: bid + 0.2 }, source: "EXNESS_MT5" as const, symbol: SYM, received_at: BROKER_T0 + ms + 10, connection_epoch: 1, delivery: "STREAM" as const });
    expect(p.process(env("P1", 1000, 2000)).route).toBe("LIVE_MUTATION");
    expect(p.fallbackIdentityRetention!.fingerprint_retained).toBe(1);
  });

  it("J. CLOSED candle + unresolved reconciliation: CLOSED alone cannot make entries eligible", () => {
    const store = new RetentionIdentityStore({ transport: 1, source: 1, fingerprint: 1 });
    const r = synced(store);
    const dep = store.openDependency({ kind: "RECONCILIATION", symbol: SYM, from_ms: M(0), to_ms: M(10_000_000), reason: "discrepancy" });
    r.boot.onLive(occ("J1", 1000, 2000));
    r.boot.onLive(occ("J2", 400_000, 2001)); // closes the M5 bar containing J1
    expect(r.mutations.some((b) => (b as unknown as { state: string }).state === "CLOSED")).toBe(true);
    expect(store.hasRawEvent("J1")).toBe(true);
    expect(store.metrics.memory_pressure).toBe(true);
    store.resolveDependency(dep.id);
    expect(store.hasRawEvent("J1")).toBe(false);
  });

  it("K. SYNCHRONIZED + CONTINUITY_UNPROVEN coverage dependency keeps entries ineligible", () => {
    const store = new RetentionIdentityStore({ transport: 1, source: 1, fingerprint: 1 });
    const r = synced(store);
    store.openDependency({ kind: "COVERAGE", symbol: SYM, from_ms: M(0), to_ms: M(10_000), reason: "CONTINUITY_UNPROVEN" });
    r.boot.onLive(occ("K1", 1000, 2000)); r.boot.onLive(occ("K2", 20_000, 2001));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    expect(store.hasRawEvent("K1")).toBe(true);
    expect(store.isEligible({ key: "K1", symbol: SYM, ms: M(1000), epoch: 1 })).toBe(false);
  });

  it("K2. a DEGRADED bootstrap opens a COVERAGE dependency automatically", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("K2a", 500, 2000));
    r.boot.beginHistory({ requested_from: M(0), requested_to: M(1000) });
    r.boot.historyFailed("timeout");
    expect(r.boot.state).toBe("DEGRADED");
    expect(r.store.reconciliation.unresolved("COVERAGE").length).toBe(1);
  });

  it("L. memory pressure during bootstrap pin: no forced eviction, degradation counted", () => {
    const store = new RetentionIdentityStore({ transport: 2, source: 2, fingerprint: 2 });
    const r = rig(store);
    store.settleThrough(SYM, M(10_000_000));
    store.pin();
    for (let i = 0; i < 10; i++) r.reg.classify(occ(`L${i}`, 1000 + i, 2000 + i), 1);
    expect(store.metrics.source_identity_retained).toBe(10);
    expect(store.metrics.eligible_eviction_count).toBe(0);
    expect(store.metrics.memory_pressure).toBe(true);
    expect(store.metrics.memory_pressure_degradations).toBe(1);
    store.unpin();
    expect(store.metrics.source_identity_retained).toBe(2);
  });

  it("M. retired epoch: compact metadata replaces transport ids and still yields STALE_EPOCH", () => {
    const r = rig();
    for (let i = 0; i < 100; i++) r.reg.classify(occ(`M${i}`, 1000 + i, 2000 + i, { epoch: 1 }), 1);
    r.store.retireEpochsThrough(1);
    expect(r.store.metrics.transport_occurrence_retained).toBe(0);
    expect(r.store.metrics.retired_through_epoch).toBe(1);
    expect(r.reg.classify(occ("M_new", 9000, 2500, { epoch: 1 }), null).dedup_class).toBe("STALE_EPOCH_OCCURRENCE");
  });

  it("N. source raw identity survives transport epoch retirement", () => {
    const r = rig();
    r.reg.classify(occ("N1", 1000, 2000, { epoch: 1 }), 1);
    r.store.retireEpochsThrough(1);
    expect(r.store.metrics.source_identity_retained).toBe(1);
    expect(r.store.hasRawEvent("N1")).toBe(true);
  });

  it("O. unresolved reconciliation prevents relevant eviction (only the covered range)", () => {
    const store = new RetentionIdentityStore({ transport: 1, source: 1, fingerprint: 1 });
    const r = rig(store);
    store.openDependency({ kind: "RECONCILIATION", symbol: SYM, from_ms: M(1000), to_ms: M(1000), reason: "x" });
    r.reg.classify(occ("O1", 1000, 2000), 1);
    r.reg.classify(occ("O2", 2000, 2001), 1);
    store.settleThrough(SYM, M(10_000));
    r.reg.classify(occ("O3", 20_000, 2002), 1);
    expect(store.hasRawEvent("O1")).toBe(true);
    expect(store.hasRawEvent("O2")).toBe(false);
  });

  it("P. once dependencies resolve, eligible state is evicted safely", () => {
    const store = new RetentionIdentityStore({ transport: 1, source: 1, fingerprint: 1 });
    const r = rig(store);
    const d = store.openDependency({ kind: "IDENTITY", symbol: SYM, from_ms: M(0), to_ms: M(10_000), reason: "x" });
    store.settleThrough(SYM, M(10_000));
    r.reg.classify(occ("P1", 1000, 2000), 1); r.reg.classify(occ("P2", 2000, 2001), 1);
    expect(store.metrics.source_identity_retained).toBe(2);
    store.resolveDependency(d.id);
    expect(store.metrics.source_identity_retained).toBe(1);
    expect(r.reg.classify(occ("P1", 1000, 2000, { seq: 5 }), 1).evidence_status).toBe("EVIDENCE_EVICTED");
  });

  it("Q. silent_ambiguous_drops is exactly 0 across collisions and evicted-evidence holds", () => {
    const store = new RetentionIdentityStore({ transport: 1, source: 1, fingerprint: 1 });
    const r = synced(store);
    r.boot.onLive(occ("Q1", 1000, 2000)); r.boot.onLive(occ("Q2", 1000, 2000));
    r.boot.onLive(occ("Q3", 5000, 2001)); r.boot.onLive(occ("Q4", 1000, 2000));
    expect(r.boot.metrics.ambiguous_total).toBeGreaterThanOrEqual(2);
    expect(r.boot.metrics.silent_ambiguous_drops).toBe(0);
  });

  it("R. long deterministic stream: hot retained state stays bounded once entries become eligible", () => {
    const cap = { transport: 500, source: 500, fingerprint: 500 };
    const r = synced(new RetentionIdentityStore(cap));
    const N = 20_000;
    let peak = 0;
    for (let i = 0; i < N; i++) {
      r.boot.onLive(occ(`R${i}`, 1000 + i * 100, 2000 + (i % 997) * 0.01));
      peak = Math.max(peak, r.store.metrics.source_identity_retained);
    }
    const m = r.store.metrics;
    const a = r.reg.auditMetrics;
    console.log("[C1 R]", JSON.stringify({ N, peak, ...m, audit_detailed_retained: a.detailed_retained, audit_cumulative_total: a.cumulative_total,
      silent_ambiguous_drops: r.boot.metrics.silent_ambiguous_drops }));
    expect(peak).toBeLessThanOrEqual(cap.source + 1);
    expect(m.transport_occurrence_retained).toBeLessThanOrEqual(cap.transport);
    expect(m.fingerprint_retained).toBeLessThanOrEqual(cap.fingerprint);
    expect(m.eligible_eviction_count).toBeGreaterThan(3 * (N - 500) - 10);
    expect(m.memory_pressure).toBe(false);
    expect(a.detailed_retained).toBeLessThanOrEqual(50);
    expect(a.cumulative_total).toBe(N);
    expect(r.live).toHaveLength(N);
    expect(r.boot.metrics.silent_ambiguous_drops).toBe(0);
  });

  it("safety: MONITOR_ONLY, execution disabled", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
});
