// PRE-2D Patch A — R1 (LIVE/BACKFILL isolation), R2 (explicit RECONCILE), R3 (classifier ≠ MTF lifecycle).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, type Bar } from "@/core/contracts";
import { BrokerFeedPipeline, routeFor, type AuditRecord } from "@/core/broker/BrokerFeedPipeline";
import { LIVE_FANOUT_TIMEFRAMES, LiveCandleFanout } from "@/core/broker/LiveCandleFanout";
import type { BrokerEventEnvelope, BrokerMarketEvent, RawBrokerTick } from "@/core/broker/types";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { BROKER_T0, SYNTHETIC_SPEC, tick } from "@/core/fixtures/syntheticExnessFixture";

const OFFSET = tick("x", 0, 1).raw.broker_time_ms - BROKER_T0;
const CFG = { maxLatencyMs: 60_000, maxReorderMs: 90_000, freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }) };

/** Envelope at an exact ms offset from T0 (received 20ms later unless given). */
function tickMs(id: string, ms: number, bid: number, o: { recvMs?: number; backfill?: boolean; epoch?: number } = {}): BrokerEventEnvelope<RawBrokerTick> {
  return Object.freeze({
    raw: Object.freeze({ raw_event_id: id, symbol: "XAUUSD", broker_time_ms: BROKER_T0 + ms + OFFSET, bid, ask: +(bid + 0.2).toFixed(2) }),
    source: "EXNESS_MT5", symbol: "XAUUSD",
    received_at: BROKER_T0 + (o.recvMs ?? ms + 20),
    connection_epoch: o.epoch ?? 1,
    delivery: o.backfill ? "BACKFILL" : "STREAM",
  });
}

function rig() {
  const clock = new ReplayClock(BROKER_T0);
  const fanout = new LiveCandleFanout("XAUUSD", clock);
  const liveCalls: BrokerMarketEvent[] = [];
  const mutations: Bar[] = [];
  for (const tf of LIVE_FANOUT_TIMEFRAMES) fanout.aggregators[tf].onBar((b) => mutations.push(b));
  const backfill: AuditRecord[] = [];
  const reconcile: AuditRecord[] = [];
  const pipe = new BrokerFeedPipeline(SYNTHETIC_SPEC, CFG, clock, (e) => { liveCalls.push(e); fanout.ingest(e); }, {
    onBackfill: (r) => backfill.push(r),
    onReconcileCandidate: (r) => reconcile.push(r),
  });
  const send = (env: BrokerEventEnvelope<RawBrokerTick>) => {
    clock.advanceTo(Math.max(clock.now(), env.received_at));
    return pipe.process(env);
  };
  const snapshot = () => JSON.stringify(LIVE_FANOUT_TIMEFRAMES.map((tf) => ({ f: fanout.aggregators[tf].current, c: fanout.aggregators[tf].closedBars })));
  return { clock, fanout, pipe, send, liveCalls, mutations, backfill, reconcile, snapshot };
}

describe("R1 — BACKFILL never mutates LIVE state", () => {
  it("routing is explicit: BACKFILL can never yield LIVE_MUTATION", () => {
    for (const d of ["ACCEPT", "ACCEPT_WITH_FLAG", "QUARANTINE", "RECONCILE", "REJECT"] as const) {
      expect(routeFor(d, "BACKFILL")).not.toBe("LIVE_MUTATION");
    }
    expect(routeFor("ACCEPT", "STREAM")).toBe("LIVE_MUTATION");
    expect(routeFor("ACCEPT_WITH_FLAG", "STREAM")).toBe("LIVE_MUTATION");
  });

  it("A: BACKFILL observation retained on history path, live sink calls == 0", () => {
    const r = rig();
    const rec = r.send(tickMs("b1", 1_000, 2345, { backfill: true }));
    expect(rec.route).toBe("BACKFILL_HISTORY");
    expect(rec.canonical_seq).toBeNull();
    expect(r.liveCalls).toHaveLength(0);
    expect(r.mutations).toHaveLength(0);
    expect(r.backfill).toEqual([rec]);
    expect(r.pipe.audit).toEqual([rec]);
    expect(r.pipe.result.backfill).toEqual([rec]);
  });

  it("B/C: BACKFILL after LIVE (overlapping the forming candle) leaves live OHLC unchanged", () => {
    const r = rig();
    r.send(tickMs("l1", 0, 2345));
    r.send(tickMs("l2", 60_000, 2346));
    const before = r.snapshot();
    const muts = r.mutations.length;
    const ahead = r.send(tickMs("b1", 120_000, 2399, { backfill: true })); // same M5 interval, after watermark
    const behind = r.send(tickMs("b2", 30_000, 2300, { backfill: true })); // same interval, behind watermark
    expect(ahead.route).toBe("BACKFILL_HISTORY");
    expect(behind.route).toBe("RECONCILIATION_CANDIDATE");
    expect(r.snapshot()).toBe(before);
    expect(r.mutations.length - muts).toBe(0);
    expect(r.liveCalls).toHaveLength(2);
    expect(r.fanout.aggregators.M5.current).toMatchObject({ open: 2345, high: 2346, low: 2345, close: 2346, tick_count: 2 });
  });

  it("BACKFILL does not advance the live watermark (no masquerade as LIVE)", () => {
    const r = rig();
    r.send(tickMs("l1", 0, 2345));
    r.send(tickMs("b1", 200_000, 2350, { backfill: true }));
    const live = r.send(tickMs("l2", 100_000, 2346));
    expect(live).toMatchObject({ route: "LIVE_MUTATION", disposition: "ACCEPT" });
  });

  it("D: BACKFILL for an already CLOSED interval leaves the CLOSED candle unchanged", () => {
    const r = rig();
    r.send(tickMs("l1", 0, 2345));
    r.send(tickMs("l2", 310_000, 2347)); // closes M5 [T0, T0+5m)
    const closed = r.fanout.aggregators.M5.closedBars[0]!;
    const frozenCopy = JSON.stringify(closed);
    const muts = r.mutations.length;
    r.send(tickMs("b1", 200_000, 2399, { backfill: true }));
    expect(r.fanout.aggregators.M5.closedBars).toHaveLength(1);
    expect(JSON.stringify(r.fanout.aggregators.M5.closedBars[0])).toBe(frozenCopy);
    expect(Object.isFrozen(closed)).toBe(true);
    expect(r.mutations.length - muts).toBe(0);
  });

  it("E: an accepted LIVE observation still reaches the live market-state path", () => {
    const r = rig();
    const rec = r.send(tickMs("l1", 0, 2345));
    expect(rec).toMatchObject({ route: "LIVE_MUTATION", disposition: "ACCEPT", canonical_seq: 0 });
    expect(r.liveCalls).toHaveLength(1);
    expect(r.pipe.result.acceptedLive).toEqual([rec]);
  });
});

describe("R2 — RECONCILE is an explicit, non-mutating route distinct from QUARANTINE", () => {
  it("A/C: RECONCILE → reconciliationCandidates +1, quarantine unchanged, live sink 0, provenance kept", () => {
    const r = rig();
    r.send(tickMs("l1", 0, 2345));
    r.send(tickMs("l2", 310_000, 2347));
    const q0 = r.pipe.quarantine.length;
    const live0 = r.liveCalls.length;
    const rec = r.send(tickMs("rc1", 100_000, 2344, { backfill: true, epoch: 2, recvMs: 320_000 }));
    expect(rec.disposition).toBe("RECONCILE");
    expect(rec.route).toBe("RECONCILIATION_CANDIDATE");
    expect(r.pipe.reconciliationCandidates).toEqual([rec]);
    expect(r.pipe.result.reconciliationCandidates).toEqual([rec]);
    expect(r.reconcile).toEqual([rec]);
    expect(r.pipe.quarantine.length).toBe(q0);
    expect(r.liveCalls.length).toBe(live0);
    expect(rec.canonical_seq).toBeNull();
    expect(rec.candidate.provenance).toMatchObject({
      raw_event_id: "rc1", source: "EXNESS_MT5", connection_epoch: 2, delivery: "BACKFILL", received_at: BROKER_T0 + 320_000,
    });
    expect(rec.anomalies.map((a) => a.classification).sort()).toEqual(["LATE_EVENT", "RECONNECT_BACKFILL"]);
    expect(rec.envelope.raw.bid).toBe(2344);
    expect(r.pipe.trace("rc1")).toBe(rec);
  });

  it("B: QUARANTINE input → quarantine path, reconciliationCandidates unchanged", () => {
    const r = rig();
    r.send(tickMs("l1", 60_000, 2345));
    const rec = r.send(tickMs("q1", 30_000, 2344)); // LIVE regression
    expect(rec).toMatchObject({ disposition: "QUARANTINE", route: "QUARANTINED" });
    expect(r.pipe.quarantine).toEqual([rec]);
    expect(r.pipe.reconciliationCandidates).toHaveLength(0);
    expect(r.reconcile).toHaveLength(0);
  });

  it("D: no RECONCILE observation mutates FORMING or CLOSED candles on any timeframe", () => {
    const r = rig();
    r.send(tickMs("l1", 0, 2345));
    r.send(tickMs("l2", 310_000, 2347)); // M5 closed, M5/M15/H1/H4 forming
    const before = r.snapshot();
    const muts = r.mutations.length;
    for (const [i, ms] of [0, 150_000, 305_000].entries()) {
      expect(r.send(tickMs(`rc${i}`, ms, 2390 + i, { backfill: true })).route).toBe("RECONCILIATION_CANDIDATE");
    }
    expect(r.snapshot()).toBe(before);
    expect(r.mutations.length - muts).toBe(0);
  });
});

describe("R3 — feed classifier does not own candle lifecycle; canonical LIVE MTF fanout", () => {
  it("classifier source has no timeframe / bucket / candle-closure knowledge", () => {
    const src = readFileSync("src/core/broker/AnomalyClassifier.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/TIMEFRAME_MS|Timeframe|timeframe|bucket|CandleAggregator|closed|tfMs|clock/i);
    expect(Object.keys(CFG).sort()).toEqual(["freshness", "maxLatencyMs", "maxReorderMs"]);
  });

  it("one canonical observation, classified once, fans out to independent M5/M15/H1/H4 lifecycles", () => {
    const r = rig();
    const closedAt: Record<string, Bar[]> = { M5: [], M15: [], H1: [], H4: [] };
    const frozenCopies = new Map<Bar, string>();
    for (const tf of LIVE_FANOUT_TIMEFRAMES) {
      r.fanout.aggregators[tf].onBar((b) => { if (b.status === "CLOSED") { closedAt[tf]!.push(b); frozenCopies.set(b, JSON.stringify(b)); } });
    }
    const st = (tf: (typeof LIVE_FANOUT_TIMEFRAMES)[number]) => r.fanout.aggregators[tf].current;
    const recs: AuditRecord[] = [];

    recs.push(r.send(tickMs("k1", 0, 2345.0)));
    recs.push(r.send(tickMs("k2", 299_999, 2345.5))); // last ms of [08:00, 08:05)
    for (const tf of LIVE_FANOUT_TIMEFRAMES) expect(st(tf)).toMatchObject({ open_time: BROKER_T0, tick_count: 2, status: "FORMING" });

    recs.push(r.send(tickMs("k3", 300_000, 2346.0))); // exactly 08:05 → NEW M5 interval
    expect(closedAt.M5!.map((b) => [b.open_time - BROKER_T0, b.close, b.tick_count])).toEqual([[0, 2345.5, 2]]);
    expect(st("M5")).toMatchObject({ open_time: BROKER_T0 + 300_000, open: 2346.0, tick_count: 1 });
    for (const tf of ["M15", "H1", "H4"] as const) expect(st(tf)).toMatchObject({ open_time: BROKER_T0, tick_count: 3, close: 2346.0, status: "FORMING" });

    recs.push(r.send(tickMs("k4", 900_000, 2347.0))); // 08:15 → M15 closes, H1/H4 forming
    expect(closedAt.M15!.map((b) => b.open_time - BROKER_T0)).toEqual([0]);
    expect(st("H1")).toMatchObject({ open_time: BROKER_T0, tick_count: 4 });

    recs.push(r.send(tickMs("k5", 3_600_000, 2348.0))); // 09:00 → H1 closes, H4 forming
    expect(closedAt.H1!.map((b) => b.open_time - BROKER_T0)).toEqual([0]);
    expect(st("H4")).toMatchObject({ open_time: BROKER_T0, tick_count: 5, status: "FORMING" });
    expect(closedAt.H4).toHaveLength(0);

    recs.push(r.send(tickMs("k6", 14_400_000, 2349.0))); // 12:00 → H4 closes
    expect(closedAt.H4!.map((b) => [b.open_time - BROKER_T0, b.tick_count])).toEqual([[0, 5]]);

    // classified ONCE per observation; closure on any timeframe never makes it invalid/late
    expect(r.pipe.audit).toHaveLength(6);
    expect(recs.every((x) => x.disposition === "ACCEPT" && x.anomalies.length === 0 && x.route === "LIVE_MUTATION")).toBe(true);
    // the SAME canonical object was delivered to the fanout
    expect(r.liveCalls).toEqual(recs.map((x) => x.candidate));
    r.liveCalls.forEach((e, i) => expect(e).toBe(recs[i]!.candidate));
    for (const tf of LIVE_FANOUT_TIMEFRAMES) expect(st(tf)!.effective_at).toBe(BROKER_T0 + 14_400_000);

    // no fabricated candles for intervals without observations (no 08:10, 08:20, ...)
    expect(closedAt.M5!.map((b) => (b.open_time - BROKER_T0) / 60_000)).toEqual([0, 5, 15, 60]);
    expect(closedAt.M15!.map((b) => (b.open_time - BROKER_T0) / 60_000)).toEqual([0, 15, 60]);
    expect(closedAt.H1!.map((b) => (b.open_time - BROKER_T0) / 60_000)).toEqual([0, 60]);

    // CLOSED mutation count == 0: each interval closed exactly once and never changed afterwards
    for (const tf of LIVE_FANOUT_TIMEFRAMES) {
      const ids = closedAt[tf]!.map((b) => b.open_time);
      expect(new Set(ids).size).toBe(ids.length);
      for (const b of closedAt[tf]!) {
        expect(Object.isFrozen(b)).toBe(true);
        expect(JSON.stringify(b)).toBe(frozenCopies.get(b));
        expect(b.closed_at!).toBeGreaterThanOrEqual(b.close_time);
      }
      expect(r.fanout.aggregators[tf].closedBars).toEqual(closedAt[tf]);
    }
  });

  it("[start, end): boundary tick belongs to the new interval on every timeframe", () => {
    const clock = new ReplayClock(BROKER_T0 + 14_400_020);
    const agg = Object.fromEntries(LIVE_FANOUT_TIMEFRAMES.map((tf) => [tf, new CandleAggregator("XAUUSD", tf, clock)]));
    const r = rig();
    r.send(tickMs("k1", 14_400_000, 2345));
    for (const tf of LIVE_FANOUT_TIMEFRAMES) {
      expect(r.fanout.aggregators[tf].current!.open_time).toBe(BROKER_T0 + 14_400_000);
      expect(agg[tf]).toBeDefined();
    }
  });

  it("H4 state cannot influence classification: a long-quiet LIVE tick stays LIVE-eligible", () => {
    const r = rig();
    r.send(tickMs("a", 0, 2345));
    const late = r.send(tickMs("b", 14_399_999, 2346));
    expect(late).toMatchObject({ route: "LIVE_MUTATION", disposition: "ACCEPT" });
  });
});

describe("Patch A safety regression", () => {
  it("MONITOR_ONLY, execution disabled", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
  it("changed modules carry no execution / account / credential / real-MT5 surface", () => {
    for (const f of ["src/core/broker/AnomalyClassifier.ts", "src/core/broker/BrokerFeedPipeline.ts", "src/core/broker/LiveCandleFanout.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/order_send|order_check|account_info|positions_get|orders_get|MetaTrader5|login\(|password|WebSocket\(/i);
    }
  });
});
