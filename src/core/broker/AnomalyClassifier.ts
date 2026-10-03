import { TIMEFRAME_MS, type Timeframe } from "../contracts";
import type { CanonicalClock } from "../temporal/CanonicalClock";
import type { FreshnessPolicy } from "../temporal/TemporalPolicy";
import type { AnomalyDisposition, BrokerMarketEvent, FeedAnomaly } from "./types";

export interface ClassifierConfig {
  /** Bucketing timeframe of the downstream aggregator (closed-bucket detection). */
  timeframe: Timeframe;
  /** ingested_at - event_at above this is flagged LATE_EVENT (configurable, not an Exness value). */
  maxLatencyMs: number;
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
 * Classifies a normalized candidate against stream state. Returns every
 * applicable observation; it never reorders or edits the event.
 */
export class AnomalyClassifier {
  private readonly seenIds = new Set<string>();
  private readonly seenContent = new Set<string>();
  private lastAccepted: BrokerMarketEvent | null = null;
  private lastEpoch: number | null = null;
  private readonly tfMs: number;

  constructor(
    private readonly cfg: ClassifierConfig,
    private readonly clock: CanonicalClock,
  ) {
    this.tfMs = TIMEFRAME_MS[cfg.timeframe];
  }

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

    const epochChanged = this.lastEpoch !== null && e.provenance.connection_epoch !== this.lastEpoch;
    if (e.provenance.delivery === "BACKFILL" || epochChanged) {
      add("RECONNECT_BACKFILL", "ACCEPT_WITH_FLAG", `epoch ${e.provenance.connection_epoch}, delivery ${e.provenance.delivery}`);
    }

    const last = this.lastAccepted;
    const bucket = Math.floor(e.event_at / this.tfMs) * this.tfMs;
    const bucketClosed = bucket + this.tfMs <= this.clock.now() ||
      (last !== null && bucket < Math.floor(last.event_at / this.tfMs) * this.tfMs);

    if (last && e.event_at < last.event_at) {
      if (bucketClosed) {
        add("LATE_EVENT", e.provenance.delivery === "BACKFILL" ? "RECONCILE" : "QUARANTINE",
          "belongs to an already-closed bucket; CLOSED candles are immutable");
      } else {
        add("OUT_OF_ORDER", "QUARANTINE", `event_at ${e.event_at} < last accepted ${last.event_at}`);
      }
    } else if (!last && bucketClosed) {
      add("LATE_EVENT", "QUARANTINE", "first event already belongs to a closed bucket");
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

  /** Commit state after the pipeline decided. Rejected/quarantined events still count as seen. */
  commit(e: BrokerMarketEvent, accepted: boolean, temporallyValid: boolean): void {
    if (!temporallyValid) return;
    this.seenIds.add(e.provenance.raw_event_id);
    this.seenContent.add(`${e.symbol}|${e.event_at}|${e.bid}|${e.ask}`);
    if (accepted) {
      this.lastAccepted = e;
      this.lastEpoch = e.provenance.connection_epoch;
    }
  }
}
