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

export interface AuditRecord {
  readonly envelope: BrokerEventEnvelope<RawBrokerTick>;
  readonly candidate: BrokerMarketEvent;
  readonly anomalies: readonly FeedAnomaly[];
  readonly disposition: AnomalyDisposition;
  /** seq on the canonical stream, or null if it did not reach it. */
  readonly canonical_seq: number | null;
}

/**
 * Raw → normalize → validate/classify → canonical sink or audit/quarantine.
 * Only ACCEPT / ACCEPT_WITH_FLAG reach the sink (e.g. a CandleAggregator).
 * Every envelope, including rejected ones, is preserved in the audit log.
 */
export class BrokerFeedPipeline {
  private readonly normalizer: BrokerNormalizer;
  private readonly classifier: AnomalyClassifier;
  private readonly log: AuditRecord[] = [];
  private seq = 0;

  constructor(
    spec: SymbolSpecification,
    cfg: ClassifierConfig,
    clock: CanonicalClock,
    private readonly sink: (e: BrokerMarketEvent) => void,
  ) {
    this.normalizer = new BrokerNormalizer(spec, clock);
    this.classifier = new AnomalyClassifier(cfg, clock);
  }

  process(env: BrokerEventEnvelope<RawBrokerTick>): AuditRecord {
    const frozenEnv = Object.freeze({ ...env, raw: Object.freeze({ ...env.raw }) });
    const candidate = this.normalizer.normalizeTick(frozenEnv, this.seq);
    const anomalies = Object.freeze(this.classifier.classify(candidate));
    const disposition = resolveDisposition(anomalies);
    const accepted = disposition === "ACCEPT" || disposition === "ACCEPT_WITH_FLAG";
    const temporallyValid = !anomalies.some((a) => a.classification === "TEMPORAL_INVALID");
    this.classifier.commit(candidate, accepted, temporallyValid);
    const record = Object.freeze<AuditRecord>({
      envelope: frozenEnv,
      candidate,
      anomalies,
      disposition,
      canonical_seq: accepted ? this.seq : null,
    });
    this.log.push(record);
    if (accepted) {
      this.seq++;
      this.sink(candidate);
    }
    return record;
  }

  get audit(): readonly AuditRecord[] {
    return this.log;
  }
  get quarantine(): readonly AuditRecord[] {
    return this.log.filter((r) => r.disposition === "QUARANTINE" || r.disposition === "RECONCILE");
  }
  trace(raw_event_id: string): AuditRecord | undefined {
    return this.log.find((r) => r.envelope.raw.raw_event_id === raw_event_id);
  }
}
