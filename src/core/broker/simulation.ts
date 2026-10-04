import type { Bar } from "../contracts";
import { CandleAggregator } from "../temporal/CandleAggregator";
import { ReplayClock } from "../temporal/CanonicalClock";
import { FreshnessPolicy } from "../temporal/TemporalPolicy";
import {
  anomalyEnvelopes,
  BROKER_T0,
  SYNTHETIC_MAX_GAP_MS,
  SYNTHETIC_MAX_LATENCY_MS,
  SYNTHETIC_MAX_REORDER_MS,
  SYNTHETIC_SPEC,
} from "../fixtures/syntheticExnessFixture";
import { BrokerFeedPipeline, type AuditRecord } from "./BrokerFeedPipeline";
import type { BrokerConnectionState, BrokerEventEnvelope, RawBrokerTick } from "./types";

export const SIMULATED_CONNECTION: BrokerConnectionState = Object.freeze({
  mode: "SIMULATION",
  status: "NOT_CONNECTED",
  epoch: 0,
  since: null,
  note: "No real MT5 connection exists in Stage 3.0A",
});

export interface BrokerSimResult {
  audit: readonly AuditRecord[];
  emitted: Bar[];
  closed: Bar[];
  forming: Bar | null;
}

/** Delivers envelopes in given order; clock advances to each received_at. No sorting. */
export function runBrokerSimulation(
  envelopes: readonly BrokerEventEnvelope<RawBrokerTick>[] = anomalyEnvelopes,
  opts: { maxGapMs?: number; maxLatencyMs?: number } = {},
): BrokerSimResult {
  const clock = new ReplayClock(BROKER_T0);
  const agg = new CandleAggregator("XAUUSD", "M5", clock);
  const emitted: Bar[] = [];
  agg.onBar((b) => emitted.push(b));
  const freshness = new FreshnessPolicy({ maxTickAgeMs: 10_000, maxGapMs: opts.maxGapMs ?? SYNTHETIC_MAX_GAP_MS });
  const pipe = new BrokerFeedPipeline(
    SYNTHETIC_SPEC,
    { maxLatencyMs: opts.maxLatencyMs ?? SYNTHETIC_MAX_LATENCY_MS, maxReorderMs: SYNTHETIC_MAX_REORDER_MS, freshness },
    clock,
    (e) => agg.ingest(e),
  );
  for (const env of envelopes) {
    clock.advanceTo(Math.max(clock.now(), env.received_at));
    pipe.process(env);
  }
  return { audit: pipe.audit, emitted, closed: [...agg.closedBars], forming: agg.current };
}
