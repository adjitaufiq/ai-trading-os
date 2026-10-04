import type { FreshnessPolicy } from "../temporal/TemporalPolicy";
import type { AnomalyDisposition, BrokerMarketEvent, FeedAnomaly } from "./types";

/**
 * Feed-quality configuration only. Deliberately contains NO timeframe and no candle
 * lifecycle knowledge (PRE-2D R3): interval ownership/closure belongs to each
 * CandleAggregator behind the LIVE fanout, never to the feed classifier.
 */
export interface ClassifierConfig {
  /** ingested_at - event_at above this is flagged LATE_EVENT (configurable, not an Exness value). */
  maxLatencyMs: number;
  /**
   * Feed-level reorder window: an event_at regression behind the live watermark up to this
   * many ms is OUT_OF_ORDER; beyond it the observation is LATE_EVENT. Pure feed temporal
   * discontinuity — independent of any candle interval. Configurable, not an Exness value.
   */
  maxReorderMs: number;
  /** Gap thresholds resolved per symbol/source. */
  freshness: FreshnessPolicy;
}

const SEVERITY: Record<AnomalyDisposition, number> = {
  ACCEPT: 0, ACCEPT_WITH_FLAG: 1, RECONCILE: 2, QUARANTINE: 3, REJECT: 4,
};

export function resolveDisposition(anomalies: readonly FeedAnomaly[]): AnomalyDisposition {
  return anomalies.reduce<AnomalyDisposition>(
    (d, a) => (SEVERITY[a.disposition] > SEVERITY[d] ? a.disposition : d),
    "ACCEPT",
  );
}

/**
 * Classifies a normalized candidate ONCE against feed/stream state. Returns every
 * applicable observation; it never reorders or edits the event, and never decides
 * which candle owns the event or whether any candle is closed.
 */
export class AnomalyClassifier {
  private readonly seenIds = new Set<string>();
  private readonly seenContent = new Set<string>();
  /** Last observation that mutated LIVE state (live watermark). BACKFILL never moves it. */
  private lastLive: BrokerMarketEvent | null = null;
  private lastEpoch: number | null = null;

  constructor(private readonly cfg: ClassifierConfig) {}

  classify(e: BrokerMarketEvent): FeedAnomaly[] {
    const id = e.provenance.raw_event_id;
    const out: FeedAnomaly[] = [];
    const add = (classification: FeedAnomaly["classification"], disposition: AnomalyDisposition, detail: string) =>
      out.push(Object.freeze({ classification, disposition, raw_event_id: id, detail }));

    const finite = [e.bid, e.ask, e.event_at, e.observed_at].every(Number.isFinite);
    if (!finite || e.ask < e.bid || !(e.event_at <= e.observed_at && e.observed_at <= e.ingested_at)) {
      add("TEMPORAL_INVALID", "REJECT", "event_at <= observed_at <= ingested_at (or price sanity) violated");
      return out;
    }

    const contentKey = `${e.symbol}|${e.event_at}|${e.bid}|${e.ask}`;
    if (this.seenIds.has(id) || this.seenContent.has(contentKey)) {
      add("DUPLICATE", "REJECT", this.seenIds.has(id) ? "raw_event_id already seen" : "identical content already seen");
      return out;
    }

    const backfill = e.provenance.delivery === "BACKFILL";
    const epochChanged = this.lastEpoch !== null && e.provenance.connection_epoch !== this.lastEpoch;
    if (backfill || epochChanged) {
      add("RECONNECT_BACKFILL", "ACCEPT_WITH_FLAG", `epoch ${e.provenance.connection_epoch}, delivery ${e.provenance.delivery}`);
    }

    const last = this.lastLive;
    if (last && e.event_at < last.event_at) {
      const regression = last.event_at - e.event_at;
      const disposition: AnomalyDisposition = backfill ? "RECONCILE" : "QUARANTINE";
      if (regression > this.cfg.maxReorderMs) {
        add("LATE_EVENT", disposition, `event_at ${regression}ms behind live watermark > reorder window ${this.cfg.maxReorderMs}ms`);
      } else {
        add("OUT_OF_ORDER", disposition, `event_at ${e.event_at} < live watermark ${last.event_at}`);
      }
    } else if (e.ingested_at - e.event_at > this.cfg.maxLatencyMs) {
      add("LATE_EVENT", "ACCEPT_WITH_FLAG", `latency ${e.ingested_at - e.event_at}ms > ${this.cfg.maxLatencyMs}ms`);
    }

    if (last && e.event_at > last.event_at) {
      const { maxGapMs } = this.cfg.freshness.resolve({ symbol: e.symbol, source: e.source });
      if (e.event_at - last.event_at > maxGapMs) {
        add("GAP", "ACCEPT_WITH_FLAG", `gap ${e.event_at - last.event_at}ms > ${maxGapMs}ms`);
      }
    }
    return out;
  }

  /**
   * Commit state after the pipeline routed the event. Every temporally valid observation
   * counts as seen (dedup); only a LIVE mutation advances the live watermark/epoch.
   */
  commit(e: BrokerMarketEvent, liveMutation: boolean, temporallyValid: boolean): void {
    if (!temporallyValid) return;
    this.seenIds.add(e.provenance.raw_event_id);
    this.seenContent.add(`${e.symbol}|${e.event_at}|${e.bid}|${e.ask}`);
    if (liveMutation) {
      this.lastLive = e;
      this.lastEpoch = e.provenance.connection_epoch;
    }
  }
}
