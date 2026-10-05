import type { CanonicalClock } from "../temporal/CanonicalClock";
import { AnomalyClassifier, resolveDisposition, type ClassifierConfig } from "./AnomalyClassifier";
import { BrokerNormalizer } from "./BrokerNormalizer";
import type {
  AnomalyDisposition,
  BrokerEventEnvelope,
  BrokerMarketEvent,
  FeedAnomaly,
  RawBrokerTick,
  SymbolSpecification,
} from "./types";

/**
 * Where an observation went. Separate from disposition (PRE-2D R1/R2):
 * - LIVE_MUTATION            — STREAM delivery with ACCEPT/ACCEPT_WITH_FLAG; the ONLY route to the live sink.
 * - BACKFILL_HISTORY         — BACKFILL delivery with ACCEPT/ACCEPT_WITH_FLAG; history/audit/discrepancy only.
 * - RECONCILIATION_CANDIDATE — RECONCILE disposition; evidence for later resolution, never a mutation.
 * - QUARANTINED / REJECTED   — audit only.
 */
export type FeedRoute = "LIVE_MUTATION" | "BACKFILL_HISTORY" | "RECONCILIATION_CANDIDATE" | "QUARANTINED" | "REJECTED";

export interface AuditRecord {
  readonly envelope: BrokerEventEnvelope<RawBrokerTick>;
  readonly candidate: BrokerMarketEvent;
  readonly anomalies: readonly FeedAnomaly[];
  readonly disposition: AnomalyDisposition;
  readonly route: FeedRoute;
  /** seq on the canonical LIVE stream, or null if it did not mutate live state. */
  readonly canonical_seq: number | null;
}

export interface BrokerFeedPipelineResult {
  readonly acceptedLive: readonly AuditRecord[];
  readonly acceptedWithFlags: readonly AuditRecord[];
  readonly backfill: readonly AuditRecord[];
  readonly quarantined: readonly AuditRecord[];
  readonly reconciliationCandidates: readonly AuditRecord[];
  readonly rejected: readonly AuditRecord[];
}

export interface NonLiveSinks {
  /** History/bootstrap/discrepancy consumer. Never wired to a live CandleAggregator. */
  readonly onBackfill?: (r: AuditRecord) => void;
  /** Reconciliation-candidate consumer (no engine yet — Patch A only defines the route). */
  readonly onReconcileCandidate?: (r: AuditRecord) => void;
}

/** Disposition × delivery → route. Delivery is explicit; BACKFILL can never yield LIVE_MUTATION. */
export function routeFor(disposition: AnomalyDisposition, delivery: BrokerEventEnvelope["delivery"]): FeedRoute {
  switch (disposition) {
    case "REJECT": return "REJECTED";
    case "QUARANTINE": return "QUARANTINED";
    case "RECONCILE": return "RECONCILIATION_CANDIDATE";
    case "ACCEPT":
    case "ACCEPT_WITH_FLAG":
      return delivery === "STREAM" ? "LIVE_MUTATION" : "BACKFILL_HISTORY";
  }
}

/**
 * Raw → normalize → classify ONCE → route. Only LIVE_MUTATION reaches the live sink
 * (e.g. a LiveCandleFanout). Every envelope, including rejected ones, is preserved in the audit log.
 */
/** R7: pipeline owns anomaly/audit/staging state; bound applies only to clean, reconstructable records. */
export interface PipelineRetention {
  readonly maxAuditRecords: number;
}
export interface PipelineRetentionMetrics {
  readonly retained: number;
  readonly evicted_clean_total: number;
  /** Flagged/quarantined/reconcile/rejected records are never evicted by the bound (audit tier). */
  readonly audit_tier_retained: number;
  readonly cumulative_by_route: Readonly<Record<FeedRoute, number>>;
}

export class BrokerFeedPipeline {
  private evictedClean = 0;
  private readonly routeCounts: Record<FeedRoute, number> = {
    LIVE_MUTATION: 0, BACKFILL_HISTORY: 0, RECONCILIATION_CANDIDATE: 0, QUARANTINED: 0, REJECTED: 0,
  };
  private readonly normalizer: BrokerNormalizer;
  private readonly classifier: AnomalyClassifier;
  private readonly log: AuditRecord[] = [];
  private seq = 0;

  constructor(
    spec: SymbolSpecification,
    cfg: ClassifierConfig,
    clock: CanonicalClock,
    private readonly liveSink: (e: BrokerMarketEvent) => void,
    private readonly nonLive: NonLiveSinks = {},
    private readonly retention: PipelineRetention | null = null,
  ) {
    this.normalizer = new BrokerNormalizer(spec, clock);
    this.classifier = new AnomalyClassifier(cfg);
  }

  process(env: BrokerEventEnvelope<RawBrokerTick>): AuditRecord {
    const frozenEnv = Object.freeze({ ...env, raw: Object.freeze({ ...env.raw }) });
    const candidate = this.normalizer.normalizeTick(frozenEnv, this.seq);
    const anomalies = Object.freeze(this.classifier.classify(candidate));
    const disposition = resolveDisposition(anomalies);
    const route = routeFor(disposition, frozenEnv.delivery);
    const live = route === "LIVE_MUTATION";
    const temporallyValid = !anomalies.some((a) => a.classification === "TEMPORAL_INVALID");
    this.classifier.commit(candidate, live, temporallyValid);
    const record = Object.freeze<AuditRecord>({
      envelope: frozenEnv,
      candidate,
      anomalies,
      disposition,
      route,
      canonical_seq: live ? this.seq : null,
    });
    this.log.push(record);
    this.routeCounts[route]++;
    this.enforceRetention();
    if (live) {
      this.seq++;
      this.liveSink(candidate);
    } else if (route === "BACKFILL_HISTORY") {
      this.nonLive.onBackfill?.(record);
    } else if (route === "RECONCILIATION_CANDIDATE") {
      this.nonLive.onReconcileCandidate?.(record);
    }
    return record;
  }

  private static isClean(r: AuditRecord): boolean {
    return (r.route === "LIVE_MUTATION" || r.route === "BACKFILL_HISTORY") && r.anomalies.length === 0;
  }

  private enforceRetention(): void {
    if (!this.retention) return;
    let excess = this.log.length - this.retention.maxAuditRecords;
    for (let i = 0; excess > 0 && i < this.log.length; ) {
      if (BrokerFeedPipeline.isClean(this.log[i]!)) { this.log.splice(i, 1); this.evictedClean++; excess--; } else i++;
    }
  }

  get retentionMetrics(): PipelineRetentionMetrics {
    return Object.freeze({
      retained: this.log.length,
      evicted_clean_total: this.evictedClean,
      audit_tier_retained: this.log.filter((r) => !BrokerFeedPipeline.isClean(r)).length,
      cumulative_by_route: Object.freeze({ ...this.routeCounts }),
    });
  }

  get audit(): readonly AuditRecord[] {
    return this.log;
  }
  get quarantine(): readonly AuditRecord[] {
    return this.log.filter((r) => r.route === "QUARANTINED");
  }
  get reconciliationCandidates(): readonly AuditRecord[] {
    return this.log.filter((r) => r.route === "RECONCILIATION_CANDIDATE");
  }
  get result(): BrokerFeedPipelineResult {
    const by = (f: (r: AuditRecord) => boolean) => Object.freeze(this.log.filter(f));
    return Object.freeze({
      acceptedLive: by((r) => r.route === "LIVE_MUTATION" && r.disposition === "ACCEPT"),
      acceptedWithFlags: by((r) => r.route === "LIVE_MUTATION" && r.disposition === "ACCEPT_WITH_FLAG"),
      backfill: by((r) => r.route === "BACKFILL_HISTORY"),
      quarantined: by((r) => r.route === "QUARANTINED"),
      reconciliationCandidates: by((r) => r.route === "RECONCILIATION_CANDIDATE"),
      rejected: by((r) => r.route === "REJECTED"),
    });
  }
  trace(raw_event_id: string): AuditRecord | undefined {
    return this.log.find((r) => r.envelope.raw.raw_event_id === raw_event_id);
  }
}
