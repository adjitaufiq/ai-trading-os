import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import { BrokerNormalizer, NORMALIZER_VERSION } from "@/core/broker/BrokerNormalizer";
import { verifyBar } from "@/core/broker/DiscrepancyVerifier";
import { runBrokerSimulation, SIMULATED_CONNECTION } from "@/core/broker/simulation";
import type { AnomalyClassification } from "@/core/broker/types";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import {
  anomalyEnvelopes,
  BROKER_T0,
  brokerBarCases,
  SYNTHETIC_SPEC,
  SYNTHETIC_TOLERANCE,
  tick,
} from "@/core/fixtures/syntheticExnessFixture";

const r = runBrokerSimulation();
const rec = (id: string, nth = 0) => r.audit.filter((a) => a.envelope.raw.raw_event_id === id)[nth]!;
const classes = (id: string, nth = 0) => rec(id, nth).anomalies.map((a) => a.classification).sort();
const normBar = (env: typeof brokerBarCases.exact) =>
  new BrokerNormalizer(SYNTHETIC_SPEC, new ReplayClock(env.received_at)).normalizeBar(env);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("broker contracts & provenance", () => {
  it("connection state is honest: SIMULATION / NOT_CONNECTED", () => {
    expect(SIMULATED_CONNECTION).toMatchObject({ mode: "SIMULATION", status: "NOT_CONNECTED" });
  });

  it("spec is marked SYNTHETIC", () => {
    expect(SYNTHETIC_SPEC.origin).toBe("SYNTHETIC");
  });

  it("every envelope (incl. rejected) is preserved raw and frozen", () => {
    expect(r.audit).toHaveLength(anomalyEnvelopes.length);
    r.audit.forEach((a, i) => {
      expect(a.envelope.raw).toEqual(anomalyEnvelopes[i]!.raw);
      expect(Object.isFrozen(a.envelope.raw)).toBe(true);
    });
  });

  it("normalized events carry the full provenance chain", () => {
    const e = rec("t01").candidate;
    expect(e.provenance).toEqual({
      raw_event_id: "t01", source: "EXNESS_MT5", symbol: "XAUUSD",
      received_at: anomalyEnvelopes[0]!.received_at, normalizer_version: NORMALIZER_VERSION,
      connection_epoch: 1, delivery: "STREAM",
    });
    expect(e.event_at).toBe(BROKER_T0); // broker offset removed
    expect(e.source).toBe("EXNESS_MT5");
  });
});

describe("anomaly classification (classification ≠ disposition)", () => {
  it("normal ticks ACCEPT", () => {
    expect(rec("t01")).toMatchObject({ disposition: "ACCEPT", anomalies: [] });
  });
  it("DUPLICATE → REJECT", () => {
    expect(classes("t02", 1)).toEqual(["DUPLICATE"]);
    expect(rec("t02", 1).disposition).toBe("REJECT");
  });
  it("OUT_OF_ORDER → QUARANTINE", () => {
    expect(classes("t03")).toEqual(["OUT_OF_ORDER"]);
    expect(rec("t03").disposition).toBe("QUARANTINE");
  });
  it("TEMPORAL_INVALID → REJECT", () => {
    expect(classes("t05")).toEqual(["TEMPORAL_INVALID"]);
    expect(rec("t05").disposition).toBe("REJECT");
  });
  it("LATE_EVENT by latency → ACCEPT_WITH_FLAG", () => {
    expect(classes("t06")).toEqual(["LATE_EVENT"]);
    expect(rec("t06").disposition).toBe("ACCEPT_WITH_FLAG");
  });
  it("LATE_EVENT into closed bucket → QUARANTINE", () => {
    expect(classes("t08")).toEqual(["LATE_EVENT"]);
    expect(rec("t08").disposition).toBe("QUARANTINE");
  });
  it("GAP → ACCEPT_WITH_FLAG", () => {
    expect(classes("t09")).toEqual(["GAP"]);
    expect(rec("t09").disposition).toBe("ACCEPT_WITH_FLAG");
  });
  it("reconnect after gap keeps both observations", () => {
    expect(classes("t10")).toEqual(["GAP", "RECONNECT_BACKFILL"]);
    expect(rec("t10").disposition).toBe("ACCEPT_WITH_FLAG");
  });
  it("backfill into closed bucket → RECONCILE with multiple observations", () => {
    expect(classes("t11")).toEqual(["LATE_EVENT", "RECONNECT_BACKFILL"]);
    expect(rec("t11").disposition).toBe("RECONCILE");
  });
  it("covers all six classifications", () => {
    const all = new Set<AnomalyClassification>(r.audit.flatMap((a) => a.anomalies.map((x) => x.classification)));
    expect([...all].sort()).toEqual(["DUPLICATE", "GAP", "LATE_EVENT", "OUT_OF_ORDER", "RECONNECT_BACKFILL", "TEMPORAL_INVALID"]);
  });
  it("only ACCEPT/ACCEPT_WITH_FLAG reach the canonical stream with contiguous seq", () => {
    const passed = r.audit.filter((a) => a.canonical_seq !== null);
    expect(passed.every((a) => a.disposition === "ACCEPT" || a.disposition === "ACCEPT_WITH_FLAG")).toBe(true);
    expect(passed.map((a) => a.canonical_seq)).toEqual(passed.map((_, i) => i));
  });
  it("gap threshold is configurable", () => {
    const loose = runBrokerSimulation(anomalyEnvelopes, { maxGapMs: 600_000 });
    expect(loose.audit.find((a) => a.envelope.raw.raw_event_id === "t09")!.disposition).toBe("ACCEPT");
  });
});

describe("CLOSED candle immutability & no silent sorting", () => {
  it("anomalous raw event remains traceable but does not mutate the CLOSED candle", () => {
    const bar0 = r.closed[0]!;
    expect(bar0).toMatchObject({ status: "CLOSED", open: 2345.1, high: 2346.0, low: 2345.1, close: 2346.0, tick_count: 4 });
    expect(Object.isFrozen(bar0)).toBe(true);
    expect(rec("t08").envelope.raw.bid).toBe(2350.0); // preserved in audit
    expect(rec("t08").canonical_seq).toBeNull();
    expect(r.emitted.filter((b) => b.open_time === BROKER_T0 && b.status === "CLOSED")).toHaveLength(1);
  });

  it("CandleAggregator does not reorder: it throws on a raw late tick", () => {
    const clock = new ReplayClock(BROKER_T0 + 400_000);
    const n = new BrokerNormalizer(SYNTHETIC_SPEC, clock);
    const agg = new CandleAggregator("XAUUSD", "M5", clock);
    agg.ingest(n.normalizeTick(tick("a", 310, 2346), 0));
    expect(() => agg.ingest(n.normalizeTick(tick("b", 200, 2346), 1))).toThrow(/Late tick/);
  });

  it("aggregator source contains no sort()", () => {
    expect(readFileSync("src/core/temporal/CandleAggregator.ts", "utf8")).not.toMatch(/\.sort\(/);
  });
});

describe("DiscrepancyVerifier", () => {
  const bar0 = r.closed[0]!;
  it("EXACT", () => {
    expect(verifyBar(bar0, normBar(brokerBarCases.exact), SYNTHETIC_SPEC, SYNTHETIC_TOLERANCE).outcome).toBe("EXACT");
  });
  it("WITHIN_TOLERANCE with point metrics", () => {
    const d = verifyBar(bar0, normBar(brokerBarCases.small), SYNTHETIC_SPEC, SYNTHETIC_TOLERANCE);
    expect(d.outcome).toBe("WITHIN_TOLERANCE");
    expect(d.metrics).toMatchObject({ close_delta_price: -0.02, close_delta_points: -2, tick_volume_delta: -1, open_time_delta_ms: 0, real_volume_delta: null });
  });
  it("tolerance is configurable", () => {
    const strict = { ...SYNTHETIC_TOLERANCE, maxPriceDeltaPoints: 1 };
    expect(verifyBar(bar0, normBar(brokerBarCases.small), SYNTHETIC_SPEC, strict).outcome).toBe("MISMATCH");
  });
  it("MISMATCH on material discrepancy", () => {
    const d = verifyBar(bar0, normBar(brokerBarCases.material), SYNTHETIC_SPEC, SYNTHETIC_TOLERANCE);
    expect(d.outcome).toBe("MISMATCH");
    expect(d.metrics!.high_delta_points).toBe(-100);
    expect(d.metrics!.closure_observation_delta_ms).toBe(bar0.closed_at! - brokerBarCases.material.received_at);
  });
  it("INSUFFICIENT_DATA for missing internal / broker candle", () => {
    expect(verifyBar(null, normBar(brokerBarCases.orphan), SYNTHETIC_SPEC, SYNTHETIC_TOLERANCE)).toMatchObject({ outcome: "INSUFFICIENT_DATA", reason: "missing internal candle" });
    expect(verifyBar(r.closed[1]!, null, SYNTHETIC_SPEC, SYNTHETIC_TOLERANCE)).toMatchObject({ outcome: "INSUFFICIENT_DATA", reason: "missing broker candle" });
  });
  it("NOT_COMPARABLE for FORMING or misaligned bars", () => {
    expect(verifyBar(r.forming, normBar(brokerBarCases.exact), SYNTHETIC_SPEC, SYNTHETIC_TOLERANCE).outcome).toBe("NOT_COMPARABLE");
    expect(verifyBar(r.closed[1]!, normBar(brokerBarCases.exact), SYNTHETIC_SPEC, SYNTHETIC_TOLERANCE).outcome).toBe("NOT_COMPARABLE");
  });
});

describe("Stage 3.0A safety", () => {
  it("MONITOR_ONLY, execution disabled", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
  it("zero real MT5 connection code", () => {
    for (const f of walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("/test/"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/MetaTrader5|mt5\.initialize|copy_ticks|symbol_info_tick|WebSocket\(/);
    }
  });
});
