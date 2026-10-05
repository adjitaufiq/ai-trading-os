// PRE-2D Patch B — R6 Observation Identity v1.
// IDENTITY != FINGERPRINT != OCCURRENCE.
// - observation_id: transport occurrence identity (instance, epoch, request, sequence, item). Never a market timestamp.
// - fingerprint:    deterministic source characteristics. EVIDENCE for classification only, never a deletion key.
// - occurrence:     one arrival of an observation, with its full provenance, always kept in the audit trail.

export type ObservationChannel = "HTTP" | "STREAM" | "HISTORY";
export type ObservationDelivery = "LIVE" | "BACKFILL";

/** One arrival of a broker tick observation with its transport provenance. */
export interface ObservationOccurrence {
  readonly raw_event_id: string;
  readonly source: "EXNESS_MT5";
  readonly broker_symbol: string;
  readonly canonical_symbol: string;
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly channel: ObservationChannel;
  readonly request_id: string;
  readonly sequence: number;
  readonly item_index: number;
  readonly delivery: ObservationDelivery;
  /** Raw broker source time (ms). */
  readonly source_event_ms: number;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly volume: number;
  readonly flags: number;
  /** UTC ms the bridge received it. */
  readonly received_at: number;
}

export type DedupClass =
  | "EXACT_TRANSPORT_DUPLICATE"
  | "PROBABLE_SOURCE_DUPLICATE"
  | "AMBIGUOUS_COLLISION"
  | "DISTINCT_OBSERVATION"
  | "STALE_EPOCH_OCCURRENCE";

export interface IdentityClassification {
  readonly observation_id: string;
  readonly fingerprint: string;
  readonly dedup_class: DedupClass;
  /** observation_ids of earlier occurrences that produced this class (evidence). */
  readonly related: readonly string[];
  readonly reason: string;
}

export function observationId(o: ObservationOccurrence): string {
  return `obs:${o.source}:${o.bridge_instance_id}:${o.connection_epoch}:${o.channel}:${o.request_id}:${o.sequence}:${o.item_index}`;
}

/** Deliberately excludes transport fields and any batch index; volume is included as evidence, not as a key. */
export function sourceFingerprint(o: ObservationOccurrence): string {
  return `fp:${o.source}|${o.broker_symbol}|${o.source_event_ms}|${o.bid}|${o.ask}|${o.last}|${o.volume}|${o.flags}`;
}

interface StoredOccurrence {
  readonly observation_id: string;
  readonly raw_event_id: string;
  readonly delivery: ObservationDelivery;
  readonly channel: ObservationChannel;
  readonly source_event_ms: number;
}

/**
 * Storage boundary for identity evidence. Patch B ships an in-memory store; Patch C (R7) can add
 * bounded retention behind this interface without changing classification semantics. Entries
 * pinned by an active bootstrap must never be evicted.
 */
export interface IdentityStore {
  hasObservation(id: string): boolean;
  hasRawEvent(raw_event_id: string): boolean;
  byFingerprint(fp: string): readonly StoredOccurrence[];
  add(fp: string, o: StoredOccurrence): void;
  pin(): void;
  unpin(): void;
  readonly pinned: boolean;
  readonly size: number;
}

export class InMemoryIdentityStore implements IdentityStore {
  private readonly ids = new Set<string>();
  private readonly raws = new Set<string>();
  private readonly fps = new Map<string, StoredOccurrence[]>();
  private pins = 0;
  hasObservation(id: string) { return this.ids.has(id); }
  hasRawEvent(r: string) { return this.raws.has(r); }
  byFingerprint(fp: string) { return this.fps.get(fp) ?? []; }
  add(fp: string, o: StoredOccurrence) {
    this.ids.add(o.observation_id);
    this.raws.add(o.raw_event_id);
    const list = this.fps.get(fp);
    if (list) list.push(o); else this.fps.set(fp, [o]);
  }
  pin() { this.pins++; }
  unpin() { this.pins = Math.max(0, this.pins - 1); }
  get pinned() { return this.pins > 0; }
  get size() { return this.ids.size; }
}

/**
 * Classifies each occurrence exactly once. Every classification is appended to the audit log —
 * including duplicates and stale-epoch occurrences — so nothing disappears without provenance.
 */
export class ObservationIdentityRegistry {
  private readonly log: { occurrence: ObservationOccurrence; classification: IdentityClassification }[] = [];
  /** Cumulative per-class counters (R7): unaffected by audit-log retention, so metrics never shrink. */
  private readonly counts: Record<DedupClass, number> = {
    EXACT_TRANSPORT_DUPLICATE: 0, PROBABLE_SOURCE_DUPLICATE: 0, AMBIGUOUS_COLLISION: 0, DISTINCT_OBSERVATION: 0, STALE_EPOCH_OCCURRENCE: 0,
  };
  private auditEvicted = 0;

  /**
   * @param maxAuditEntries optional R7 bound on the in-memory audit log. Trimming never happens while the
   * store is pinned (active bootstrap/handoff), and every trimmed entry is counted (audit_evicted).
   */
  constructor(private readonly store: IdentityStore = new InMemoryIdentityStore(), private readonly maxAuditEntries: number | null = null) {}

  classify(o: ObservationOccurrence, activeEpoch: number | null): IdentityClassification {
    const id = observationId(o);
    const fp = sourceFingerprint(o);
    let c: IdentityClassification;
    if (activeEpoch !== null && o.connection_epoch < activeEpoch) {
      c = { observation_id: id, fingerprint: fp, dedup_class: "STALE_EPOCH_OCCURRENCE", related: [],
        reason: `epoch ${o.connection_epoch} < active epoch ${activeEpoch}` };
    } else if (this.store.hasObservation(id) || this.store.hasRawEvent(o.raw_event_id)) {
      c = { observation_id: id, fingerprint: fp, dedup_class: "EXACT_TRANSPORT_DUPLICATE", related: [id],
        reason: this.store.hasObservation(id) ? "same transport occurrence identity already observed" : "same raw_event_id already observed" };
    } else {
      const prior = this.store.byFingerprint(fp);
      if (prior.length === 0) {
        c = { observation_id: id, fingerprint: fp, dedup_class: "DISTINCT_OBSERVATION", related: [], reason: "no matching fingerprint" };
      } else {
        const crossPath = prior.filter((p) => p.delivery !== o.delivery || p.channel !== o.channel);
        if (crossPath.length > 0) {
          c = { observation_id: id, fingerprint: fp, dedup_class: "PROBABLE_SOURCE_DUPLICATE",
            related: crossPath.map((p) => p.observation_id),
            reason: "identical source fingerprint seen via a different delivery/channel; not proven identical" };
        } else {
          c = { observation_id: id, fingerprint: fp, dedup_class: "AMBIGUOUS_COLLISION",
            related: prior.map((p) => p.observation_id),
            reason: "identical source fingerprint on the same path with distinct transport identity; may be a distinct occurrence" };
        }
      }
      this.store.add(fp, { observation_id: id, raw_event_id: o.raw_event_id, delivery: o.delivery, channel: o.channel, source_event_ms: o.source_event_ms });
    }
    const frozen = Object.freeze({ ...c, related: Object.freeze([...c.related]) });
    this.log.push(Object.freeze({ occurrence: o, classification: frozen }));
    this.counts[frozen.dedup_class]++;
    this.trimAudit();
    return frozen;
  }

  /** Bounded audit retention; called on classify and after the owning operation unpins. */
  trimAudit(): void {
    if (this.maxAuditEntries === null || this.store.pinned) return;
    while (this.log.length > this.maxAuditEntries) { this.log.shift(); this.auditEvicted++; }
  }

  get classCounts(): Readonly<Record<DedupClass, number>> {
    return Object.freeze({ ...this.counts });
  }
  get auditEvictedCount(): number {
    return this.auditEvicted;
  }

  get audit(): readonly { occurrence: ObservationOccurrence; classification: IdentityClassification }[] {
    return this.log;
  }
  get identityStore(): IdentityStore {
    return this.store;
  }
}
