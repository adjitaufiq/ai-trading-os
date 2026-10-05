import type { FreshnessPolicy } from "../temporal/TemporalPolicy";
import type { AnomalyDisposition, BrokerMarketEvent, FeedAnomaly } from "./types";

/**
 * C1: identity verdict supplied by the single dedup authority (ObservationIdentityRegistry / its
 * retention store, or the pipeline's fallback store). The classifier holds NO identity memory.
 */
export interface IdentityHint {
  readonly dedup_class: "EXACT_TRANSPORT_DUPLICATE" | "PROBABLE_SOURCE_DUPLICATE" | "AMBIGUOUS_COLLISION" | "DISTINCT_OBSERVATION" | "STALE_EPOCH_OCCURRENCE";
  readonly evidence_status: "PROVEN" | "EVIDENCE_EVICTED";
}

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
  /**
   * Positive cross-source time skew tolerance (finite) (source time ahead of bridge, or bridge ahead of client).
   * Default 0 = strict ordering. Not an Exness value; an explicit operator policy.
   */
  maxSourceTimeSkewMs?: number;
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
  /** Last observation that mutated LIVE state (live watermark). BACKFILL never moves it. */
  private lastLive: BrokerMarketEvent | null = null;
  private lastEpoch: number | null = null;

  constructor(private readonly cfg: ClassifierConfig) {}

  classify(e: BrokerMarketEvent, identity: IdentityHint): FeedAnomaly[] {
    const id = e.provenance.raw_event_id;
    const out: FeedAnomaly[] = [];
    const add = (classification: FeedAnomaly["classification"], disposition: AnomalyDisposition, detail: string) =>
      out.push(Object.freeze({ classification, disposition, raw_event_id: id, detail }));

    const finite = [e.bid, e.ask, e.event_at, e.observed_at].every(Number.isFinite);
    // Cross-source time comparisons (source → bridge → client) tolerate a bounded positive skew only.
    // Raw times are never edited; skew is flagged and audited. Beyond the bound ⇒ TEMPORAL_INVALID.
    const skew = Math.max(0, this.cfg.maxSourceTimeSkewMs ?? 0);
    const srcAhead = e.event_at - e.observed_at;
    const bridgeAhead = e.observed_at - e.ingested_at;
    if (!finite || e.ask < e.bid || srcAhead > skew || bridgeAhead > skew) {
      add("TEMPORAL_INVALID", "REJECT", `event_at <= observed_at <= ingested_at (skew limit ${skew}ms) or price sanity violated`);
      return out;
    }
    if (srcAhead > 0) add("SOURCE_TIME_SKEW", "ACCEPT_WITH_FLAG", `event_at ${srcAhead}ms ahead of observed_at (limit ${skew}ms)`);
    if (bridgeAhead > 0) add("SOURCE_TIME_SKEW", "ACCEPT_WITH_FLAG", `observed_at ${bridgeAhead}ms ahead of ingested_at (limit ${skew}ms)`);

    switch (identity.dedup_class) {
      case "EXACT_TRANSPORT_DUPLICATE":
        add("DUPLICATE", "REJECT", "raw_event_id already seen (identity authority)");
        return out;
      case "STALE_EPOCH_OCCURRENCE":
        add("RECONNECT_BACKFILL", "QUARANTINE", "stale transport epoch (identity authority)");
        return out;
      case "PROBABLE_SOURCE_DUPLICATE":
      case "AMBIGUOUS_COLLISION":
        // PRE-2D R6: identical content is NOT proof of the same occurrence. Flag, never drop.
        if (identity.evidence_status === "EVIDENCE_EVICTED") {
          add("AMBIGUOUS_COLLISION", "RECONCILE", "identity evidence evicted; distinctness unproven (C1)");
        } else {
          add("AMBIGUOUS_COLLISION", "ACCEPT_WITH_FLAG", "identical source content already seen with a distinct raw_event_id");
        }
        break;
      case "DISTINCT_OBSERVATION":
        break;
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
   * Commit feed state after routing. Only a LIVE mutation advances the live watermark/epoch.
   * Identity (dedup) memory is NOT kept here (C1) — it lives in the identity authority.
   */
  commit(e: BrokerMarketEvent, liveMutation: boolean, temporallyValid: boolean): void {
    if (!temporallyValid) return;
    if (liveMutation) {
      this.lastLive = e;
      this.lastEpoch = e.provenance.connection_epoch;
    }
  }
}
