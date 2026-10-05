// PRE-2D Patch B — R4 (history → live bootstrap) + R6 (observation identity v1). Deterministic adversarial matrix.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, type Bar } from "@/core/contracts";
import { BrokerFeedPipeline, routeFor } from "@/core/broker/BrokerFeedPipeline";
import { LIVE_FANOUT_TIMEFRAMES, LiveCandleFanout } from "@/core/broker/LiveCandleFanout";
import { BootstrapCoordinator, type BootstrapHistoryCoverage, type FeedPipelinePort } from "@/core/broker/bootstrap/BootstrapCoordinator";
import { ObservationIdentityRegistry, observationId, sourceFingerprint, type ObservationOccurrence } from "@/core/broker/identity/ObservationIdentity";
import type { BrokerMarketEvent } from "@/core/broker/types";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { BROKER_T0, SYNTHETIC_SPEC } from "@/core/fixtures/syntheticExnessFixture";

const OFFSET = SYNTHETIC_SPEC.broker_utc_offset_ms;
const CFG = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };

interface O { delivery?: "LIVE" | "BACKFILL"; epoch?: number; seq?: number; channel?: "HTTP" | "STREAM" | "HISTORY"; req?: string; item?: number; inst?: string; recv?: number; ask?: number }
let auto = 0;
function occ(id: string, ms: number, bid: number, o: O = {}): ObservationOccurrence {
  const delivery = o.delivery ?? "LIVE";
  return Object.freeze({
    raw_event_id: id, source: "EXNESS_MT5", broker_symbol: "XAUUSD", canonical_symbol: "XAUUSD",
    bridge_instance_id: o.inst ?? "gw-1", connection_epoch: o.epoch ?? 1,
    channel: o.channel ?? (delivery === "LIVE" ? "STREAM" : "HISTORY"),
    request_id: o.req ?? (delivery === "LIVE" ? "stream" : "hist-1"), sequence: o.seq ?? ++auto, item_index: o.item ?? 0,
    delivery, source_event_ms: BROKER_T0 + OFFSET + ms, bid, ask: o.ask ?? +(bid + 0.2).toFixed(2), last: 0, volume: 0, flags: 6,
    received_at: BROKER_T0 + (o.recv ?? ms + 20),
  });
}
const hist = (id: string, ms: number, bid: number, item: number, o: O = {}) => occ(id, ms, bid, { delivery: "BACKFILL", seq: 1, item, ...o });
const cov = (n: number, newestMs: number | null, status: BootstrapHistoryCoverage["coverage_status"] = "COMPLETE"): BootstrapHistoryCoverage =>
  ({ requested_from: BROKER_T0 - 600_000, requested_to: BROKER_T0 + 600_000, returned_count: n, oldest_returned_at: null, newest_returned_at: newestMs === null ? null : BROKER_T0 + OFFSET + newestMs, coverage_status: status });

function rig(wrap?: (p: FeedPipelinePort) => FeedPipelinePort) {
  const clock = new ReplayClock(BROKER_T0 - 3_600_000);
  clock.advanceTo(BROKER_T0 + 3_600_000); // all observations below are already received by "now"
  const fanout = new LiveCandleFanout("XAUUSD", clock);
  const mutations: Bar[] = [];
  for (const tf of LIVE_FANOUT_TIMEFRAMES) fanout.aggregators[tf].onBar((b) => mutations.push(b));
  const live: BrokerMarketEvent[] = [];
  const pipe = new BrokerFeedPipeline(SYNTHETIC_SPEC, CFG, clock, (e) => { live.push(e); fanout.ingest(e); });
  const boot = new BootstrapCoordinator(wrap ? wrap(pipe) : pipe, new ObservationIdentityRegistry());
  return { clock, fanout, mutations, live, pipe, boot };
}
const H = (n: number) => n * 1000;

describe("R4 bootstrap lifecycle", () => {
  it("1+2: LIVE before and during history fetch is buffered, not processed, not lost", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("L1", H(10), 2345.1));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.onLive(occ("L2", H(11), 2345.2));
    r.boot.onLive(occ("L3", H(12), 2345.3));
    expect(r.boot.state).toBe("FETCHING_HISTORY");
    expect(r.boot.snapshot().buffered.map((b) => b.raw_event_id)).toEqual(["L1", "L2", "L3"]);
    expect(r.live).toHaveLength(0);
    expect(r.mutations).toHaveLength(0);
    r.boot.historyReceived([hist("B1", H(1), 2344.0, 0)], cov(1, H(1)));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    expect(r.live.map((e) => e.provenance.raw_event_id)).toEqual(["L1", "L2", "L3"]);
    expect(r.live.every((e) => e.provenance.delivery === "STREAM")).toBe(true);
  });

  it("3: history overlapping buffered LIVE is classified, not assumed duplicate; LIVE still mutates once", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("L1", H(5), 2345.1));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([hist("B1", H(4), 2345.0, 0), hist("B2", H(5), 2345.1, 1)], cov(2, H(5)));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    const l1 = r.boot.snapshot().occurrences.find((a) => a.occurrence.raw_event_id === "L1")!;
    expect(l1.identity.dedup_class).toBe("PROBABLE_SOURCE_DUPLICATE");
    expect(l1.action).toBe("FORWARDED");
    expect(r.boot.snapshot().separation).toMatchObject({ relation: "OVERLAPPING", loss_inferred: false });
    expect(r.live.map((e) => e.provenance.raw_event_id)).toEqual(["L1"]);
  });

  it("4: request COMPLETE with PARTIAL coverage never claims market completeness", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([hist("B1", H(1), 2344, 0)], cov(1, H(1), "PARTIAL"));
    const h = r.boot.snapshot().history!;
    expect(h.request_completed).toBe(true);
    expect(h.coverage!.coverage_status).toBe("PARTIAL");
    expect(h.market_coverage_proven_complete).toBe(false);
  });

  it("5: no boundary tick → no fabricated tick or candle bridging history and live", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("L1", 5 * 60_000 + 300, 2346));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([hist("B1", 4 * 60_000 + 59_900, 2345, 0)], cov(1, 4 * 60_000 + 59_900));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    const m5 = r.fanout.aggregators.M5;
    expect(m5.closedBars).toHaveLength(0);
    expect(m5.current!.tick_count).toBe(1);
    expect(m5.current!.open_time).toBe(BROKER_T0 + 5 * 60_000);
    expect(r.live).toHaveLength(1);
    expect(r.boot.snapshot().separation).toMatchObject({ relation: "SEPARATED", loss_inferred: false }); // LWM > HWM ≠ loss
  });

  it("13: history fetch failure → DEGRADED with buffered evidence preserved", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("L1", H(1), 2345));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyFailed("TIMEOUT");
    expect(r.boot.state).toBe("DEGRADED");
    const s = r.boot.archivedSnapshots.at(-1)!;
    expect(s.degraded_reason).toMatch(/HISTORY_FETCH_FAILED/);
    expect(s.buffered.map((b) => b.raw_event_id)).toEqual(["L1"]);
    expect(r.live).toHaveLength(0);
  });

  it("14: history replay failure → DEGRADED, never SYNCHRONIZED", () => {
    const r = rig((p) => ({ process: (env) => { if (env.delivery === "BACKFILL") throw new Error("replay boom"); return p.process(env); } }));
    r.boot.start(1);
    r.boot.onLive(occ("L1", H(2), 2345));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([hist("B1", H(1), 2344, 0)], cov(1, H(1)));
    expect(r.boot.state).toBe("DEGRADED");
    expect(r.boot.snapshot().degraded_reason).toMatch(/HISTORY_REPLAY_FAILED: replay boom/);
    expect(r.boot.snapshot().buffered).toHaveLength(1);
  });

  it("14b: a history item labelled LIVE is refused (BACKFILL masquerade)", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([occ("X", H(1), 2344)], cov(1, H(1)));
    expect(r.boot.state).toBe("DEGRADED");
    expect(r.live).toHaveLength(0);
  });

  it("15: buffer drain failure → DEGRADED with audit snapshot", () => {
    const r = rig((p) => ({ process: (env) => { if (env.raw.raw_event_id === "L2") throw new Error("drain boom"); return p.process(env); } }));
    r.boot.start(1);
    r.boot.onLive(occ("L1", H(1), 2345));
    r.boot.onLive(occ("L2", H(2), 2346));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    expect(r.boot.state).toBe("DEGRADED");
    const s = r.boot.archivedSnapshots.at(-1)!;
    expect(s.degraded_reason).toMatch(/BUFFER_DRAIN_FAILED/);
    expect(s.buffered.map((b) => b.raw_event_id)).toEqual(["L1", "L2"]);
  });

  it("16+17: history completion cannot advance LiveAcceptedFrontier; BACKFILL never mutates live", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([hist("B1", H(1), 2344, 0), hist("B2", H(2), 2345, 1)], cov(2, H(2)));
    expect(r.boot.liveAcceptedFrontier).toBeNull();
    expect(r.live).toHaveLength(0);
    expect(r.mutations).toHaveLength(0);
    expect(r.boot.snapshot().occurrences.every((a) => a.pipeline!.route === "BACKFILL_HISTORY")).toBe(true);
    expect(r.boot.snapshot().handoff).toEqual({ live_frontier_at_handoff: null, history_newest_returned_at: BROKER_T0 + OFFSET + H(2) });
  });

  it("18: RECONCILE route cannot mutate live", () => {
    expect(routeFor("RECONCILE", "STREAM")).toBe("RECONCILIATION_CANDIDATE");
    const r = rig();
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    r.boot.onLive(occ("L1", H(200), 2345));
    const before = r.mutations.length;
    r.boot.onLive(occ("B-late", H(10), 2340, { delivery: "LIVE" })); // behind frontier → QUARANTINE, no mutation
    // an actual BACKFILL behind the live frontier routes RECONCILE
    const rec = r.pipe.process({ raw: { raw_event_id: "BF", symbol: "XAUUSD", broker_time_ms: BROKER_T0 + OFFSET + H(5), bid: 2340, ask: 2340.2 }, source: "EXNESS_MT5", symbol: "XAUUSD", received_at: BROKER_T0 + H(5) + 20, connection_epoch: 1, delivery: "BACKFILL" });
    expect(rec.route).toBe("RECONCILIATION_CANDIDATE");
    expect(r.mutations.length).toBe(before);
  });

  it("19: unresolved handoff uncertainty blocks SYNCHRONIZED", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("P1", H(3), 2345, { channel: "HTTP", req: "poll-1" }));
    r.boot.onLive(occ("S1", H(3), 2345, { channel: "STREAM" })); // same fingerprint via another LIVE channel
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    expect(r.boot.state).toBe("DEGRADED");
    expect(r.boot.snapshot().degraded_reason).toMatch(/UNRESOLVED_HANDOFF_UNCERTAINTY/);
    const s1 = r.boot.snapshot().occurrences.find((a) => a.occurrence.raw_event_id === "S1")!;
    expect(s1.identity.dedup_class).toBe("PROBABLE_SOURCE_DUPLICATE");
    expect(s1.action).toBe("HELD_RECONCILE");
    expect(r.boot.snapshot().reconciliation.candidates).toBe(1);
  });

  it("20: successful bootstrap reaches SYNCHRONIZED; live continuation is monotonic", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("L1", H(10), 2345.1));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.onLive(occ("L2", H(11), 2345.2));
    r.boot.historyReceived([hist("B1", H(5), 2344, 0), hist("B2", H(6), 2344.5, 1)], cov(2, H(6)));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    expect(r.boot.snapshot().transitions.map((t) => t.to)).toEqual(["BUFFERING_LIVE", "FETCHING_HISTORY", "REPLAYING_HISTORY", "DRAINING_BUFFER", "SYNCHRONIZED"]);
    const frontiers: number[] = [r.boot.liveAcceptedFrontier!.event_at];
    for (let i = 0; i < 5; i++) {
      r.boot.onLive(occ(`C${i}`, H(12 + i), 2345.3 + i / 10));
      frontiers.push(r.boot.liveAcceptedFrontier!.event_at);
    }
    expect([...frontiers].sort((a, b) => a - b)).toEqual(frontiers);
    expect(r.live.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("deterministic: identical inputs → identical snapshots", () => {
    const run = () => {
      auto = 0;
      const r = rig();
      r.boot.start(1);
      r.boot.onLive(occ("L1", H(10), 2345.1));
      r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
      r.boot.historyReceived([hist("B1", H(5), 2344, 0)], cov(1, H(5)));
      return JSON.stringify({ s: r.boot.snapshot(), c: r.fanout.aggregators.M5.current });
    };
    expect(run()).toBe(run());
  });
});

describe("R6 observation identity", () => {
  it("identity ≠ fingerprint: id is transport occurrence, fingerprint excludes transport", () => {
    const a = occ("a", H(1), 2345, { seq: 1 });
    const b = occ("b", H(1), 2345, { seq: 2 });
    expect(observationId(a)).not.toBe(observationId(b));
    expect(sourceFingerprint(a)).toBe(sourceFingerprint(b));
    expect(sourceFingerprint(a)).not.toContain("gw-1");
  });

  it("6+9: same-ms same-price twice → AMBIGUOUS_COLLISION, both reach live; silent_ambiguous_drops == 0", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    r.boot.onLive(occ("A", H(1), 2345, { seq: 10 }));
    r.boot.onLive(occ("B", H(1), 2345, { seq: 11 }));
    const occs = r.boot.snapshot().occurrences;
    expect(occs.map((a) => a.identity.dedup_class)).toEqual(["DISTINCT_OBSERVATION", "AMBIGUOUS_COLLISION"]);
    expect(occs[1]!.action).toBe("FORWARDED");
    expect(occs[1]!.pipeline!.anomalies.map((x) => x.classification)).toContain("AMBIGUOUS_COLLISION");
    expect(r.live.map((e) => e.provenance.raw_event_id)).toEqual(["A", "B"]);
    expect(r.fanout.aggregators.M5.current!.tick_count).toBe(2);
    expect(r.boot.metrics).toMatchObject({ ambiguous_total: 1, ambiguous_audited: 1, silent_ambiguous_drops: 0 });
  });

  it("7: exact transport duplicate is suppressed with audit, not counted as ambiguous", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    const o = occ("A", H(1), 2345, { seq: 10 });
    r.boot.onLive(o);
    r.boot.onLive(o);
    const occs = r.boot.snapshot().occurrences;
    expect(occs[1]!.identity.dedup_class).toBe("EXACT_TRANSPORT_DUPLICATE");
    expect(occs[1]!.action).toBe("SUPPRESSED_EXACT_DUPLICATE");
    expect(r.live).toHaveLength(1);
    expect(r.boot.metrics.silent_ambiguous_drops).toBe(0);
  });

  it("8: probable source duplicate (LIVE vs BACKFILL) is classified with related evidence", () => {
    const reg = new ObservationIdentityRegistry();
    reg.classify(hist("B", H(1), 2345, 0), 1);
    const c = reg.classify(occ("L", H(1), 2345), 1);
    expect(c.dedup_class).toBe("PROBABLE_SOURCE_DUPLICATE");
    expect(c.related).toHaveLength(1);
  });

  it("10: distinct same-ms observation (different price) → DISTINCT_OBSERVATION", () => {
    const reg = new ObservationIdentityRegistry();
    reg.classify(occ("A", H(1), 2345), 1);
    expect(reg.classify(occ("B", H(1), 2345.01), 1).dedup_class).toBe("DISTINCT_OBSERVATION");
  });

  it("11: connection epoch changes during bootstrap → DEGRADED (handoff uncertainty)", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.onLive(occ("L1", H(1), 2345, { epoch: 1 }));
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.onLive(occ("L2", H(2), 2346, { epoch: 2 }));
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    expect(r.boot.state).toBe("DEGRADED");
    expect(r.boot.snapshot().uncertainties.join()).toMatch(/EPOCH_CHANGED_DURING_BOOTSTRAP 1→2/);
  });

  it("12: stale-epoch observation after a new epoch is active cannot mutate state; audit kept", () => {
    const r = rig();
    r.boot.start(1);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    r.boot.onLive(occ("L1", H(1), 2345, { epoch: 1 }));
    r.boot.onEpochChange(2);
    expect(r.boot.state).toBe("DEGRADED");
    r.boot.start(2);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    expect(r.boot.state).toBe("SYNCHRONIZED");
    const before = JSON.stringify(LIVE_FANOUT_TIMEFRAMES.map((tf) => r.fanout.aggregators[tf].current));
    r.boot.onLive(occ("OLD", H(2), 2399, { epoch: 1 }));
    const a = r.boot.snapshot().occurrences.at(-1)!;
    expect(a.identity.dedup_class).toBe("STALE_EPOCH_OCCURRENCE");
    expect(a.action).toBe("HELD_STALE_EPOCH");
    expect(a.pipeline).toBeNull();
    expect(JSON.stringify(LIVE_FANOUT_TIMEFRAMES.map((tf) => r.fanout.aggregators[tf].current))).toBe(before);
    expect(r.boot.archivedSnapshots.length).toBeGreaterThanOrEqual(1); // previous run preserved, not reset away
  });

  it("R7 boundary: identity store is pinned during active bootstrap and released on SYNCHRONIZED", () => {
    const r = rig();
    r.boot.start(1);
    expect(r.boot.identityRegistry.identityStore.pinned).toBe(true);
    r.boot.beginHistory({ requested_from: 0, requested_to: 1 });
    r.boot.historyReceived([], cov(0, null, "EMPTY"));
    expect(r.boot.identityRegistry.identityStore.pinned).toBe(false);
  });
});

describe("Patch B safety", () => {
  it("MONITOR_ONLY, execution disabled, no execution surface in Patch B modules", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    for (const f of ["src/core/broker/bootstrap/BootstrapCoordinator.ts", "src/core/broker/identity/ObservationIdentity.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/order_send|order_check|\bBUY\b|\bSELL\b|positions?_|Date\.now\(|WebSocket\(/);
    }
  });
});
