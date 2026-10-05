// C1 Retention Contract v1 — five separate retention domains for observation identity evidence.
// Ownership: this store (behind ObservationIdentityRegistry) is the ONLY persistent dedup authority.
// AnomalyClassifier holds no identity memory; it consumes the registry's classification as a hint.
//
// Semantic eligibility FIRST: operational capacity may evict only entries that are already eligible:
//   partition_not_active (entry strictly before the owner's settled watermark for that symbol,
//                         or in a retired transport epoch for the transport domain)
//   AND store not pinned
//   AND no unresolved IDENTITY / OVERLAP / RECONCILIATION / COVERAGE dependency covering the entry
//   AND post-eviction classification stays safe — guaranteed by the evidence horizon: once an entry
//       is forgotten, any later occurrence at or before its source time is classified
//       EVIDENCE_EVICTED (never DISTINCT) and is held for reconciliation by the owner.
// CLOSED candles, SYNCHRONIZED state and cache capacity are NOT inputs to eligibility.
// If capacity is exceeded and nothing is eligible: nothing is evicted, a degradation is counted.

export type DependencyKind = "IDENTITY" | "OVERLAP" | "RECONCILIATION" | "COVERAGE";

export interface RetentionDependency {
  readonly id: string;
  readonly kind: DependencyKind;
  readonly symbol: string;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly reason: string;
}

/** Domain D — unresolved overlap/gap/discrepancy/coverage/identity dependencies. Holds only unresolved items. */
export class ReconciliationRetention {
  private readonly deps = new Map<string, RetentionDependency>();
  private opened = 0;
  private resolved = 0;
  open(d: Omit<RetentionDependency, "id"> & { id?: string }): RetentionDependency {
    const dep = Object.freeze({ ...d, id: d.id ?? `dep:${d.kind}:${d.symbol}:${this.opened}` });
    this.deps.set(dep.id, dep);
    this.opened++;
    return dep;
  }
  resolve(id: string): boolean {
    const ok = this.deps.delete(id);
    if (ok) this.resolved++;
    return ok;
  }
  blocking(symbol: string, ms: number): RetentionDependency[] {
    const out: RetentionDependency[] = [];
    for (const d of this.deps.values()) if (d.symbol === symbol && ms >= d.from_ms && ms <= d.to_ms) out.push(d);
    return out;
  }
  unresolved(kind?: DependencyKind): RetentionDependency[] {
    return [...this.deps.values()].filter((d) => !kind || d.kind === kind);
  }
  get size() { return this.deps.size; }
  get counters() { return Object.freeze({ opened_total: this.opened, resolved_total: this.resolved }); }
}

interface HotEntry {
  readonly key: string;
  readonly symbol: string;
  readonly ms: number;
  readonly epoch: number;
}

/** Insertion-ordered hot set. Eviction scans for eligible entries; ineligible entries are never removed. */
class HotDomain<E extends HotEntry> {
  protected readonly entries = new Map<string, E[]>();
  private count = 0;
  evicted = 0;
  add(e: E) {
    const l = this.entries.get(e.key);
    if (l) l.push(e); else this.entries.set(e.key, [e]);
    this.count++;
  }
  has(key: string) { return this.entries.has(key); }
  get(key: string): readonly E[] { return this.entries.get(key) ?? []; }
  get size() { return this.count; }
  /** Remove eligible entries (oldest first) until size <= target. Returns evicted entries. */
  evictEligible(target: number, eligible: (e: E) => boolean): E[] {
    const out: E[] = [];
    if (this.count <= target) return out;
    for (const [key, list] of this.entries) {
      for (let i = 0; i < list.length && this.count > target; ) {
        if (eligible(list[i]!)) { out.push(list.splice(i, 1)[0]!); this.count--; this.evicted++; } else i++;
      }
      if (list.length === 0) this.entries.delete(key);
      if (this.count <= target) break;
    }
    return out;
  }
  removeWhere(pred: (e: E) => boolean): number {
    let n = 0;
    for (const [key, list] of this.entries) {
      for (let i = 0; i < list.length; ) if (pred(list[i]!)) { list.splice(i, 1); n++; this.count--; } else i++;
      if (list.length === 0) this.entries.delete(key);
    }
    this.evicted += n;
    return n;
  }
}

/** Domain A — transport occurrence identity (observation_id: instance/epoch/request/sequence/item). */
export class TransportOccurrenceRetention extends HotDomain<HotEntry> {
  /** Compact retirement metadata: every epoch <= this is retired; its occurrences are STALE by rule. */
  retiredThroughEpoch: number | null = null;
}
/** Domain B — source raw identity (raw_event_id). NOT epoch-scoped; survives transport epoch retirement. */
export class SourceIdentityRetention extends HotDomain<HotEntry> {}
/** Domain C — content-equality evidence. Same fingerprint != same observation. */
export class FingerprintRetention extends HotDomain<HotEntry & { readonly stored: StoredOcc }> {}

export interface StoredOcc {
  readonly observation_id: string;
  readonly raw_event_id: string;
  readonly delivery: "LIVE" | "BACKFILL";
  readonly channel: "HTTP" | "STREAM" | "HISTORY";
  readonly source_event_ms: number;
  readonly broker_symbol?: string;
  readonly connection_epoch?: number;
}

export interface RetentionCapacity {
  readonly transport: number;
  readonly source: number;
  readonly fingerprint: number;
}

export interface RetentionMetrics {
  readonly transport_occurrence_retained: number;
  readonly source_identity_retained: number;
  readonly fingerprint_retained: number;
  readonly reconciliation_retained: number;
  readonly eligible_eviction_count: number;
  readonly memory_pressure_degradations: number;
  readonly memory_pressure: boolean;
  readonly unresolved_identity_count: number;
  readonly retired_through_epoch: number | null;
  readonly pins: number;
  readonly capacity: RetentionCapacity;
}

export const DEFAULT_RETENTION_CAPACITY: RetentionCapacity = Object.freeze({ transport: 50_000, source: 50_000, fingerprint: 50_000 });

/** C1 identity store: implements the IdentityStore boundary over domains A–D. */
export class RetentionIdentityStore {
  readonly transport = new TransportOccurrenceRetention();
  readonly source = new SourceIdentityRetention();
  readonly fingerprint = new FingerprintRetention();
  readonly reconciliation = new ReconciliationRetention();
  private readonly settled = new Map<string, number>();
  /** Per-symbol max source_event_ms of any forgotten source/fingerprint evidence. */
  private readonly horizon = new Map<string, number>();
  private pins = 0;
  private pressureCount = 0;
  private pressureNow = false;

  constructor(readonly capacity: RetentionCapacity = DEFAULT_RETENTION_CAPACITY) {
    for (const v of Object.values(capacity)) if (!(v > 0)) throw new Error("capacity must be > 0");
  }

  // --- IdentityStore boundary ---
  hasObservation(id: string) { return this.transport.has(id); }
  hasRawEvent(r: string) { return this.source.has(r); }
  byFingerprint(fp: string): readonly StoredOcc[] { return this.fingerprint.get(fp).map((e) => e.stored); }
  add(fp: string, o: StoredOcc) {
    const symbol = o.broker_symbol ?? "?";
    const epoch = o.connection_epoch ?? 0;
    const ms = o.source_event_ms;
    this.transport.add({ key: o.observation_id, symbol, ms, epoch });
    this.source.add({ key: o.raw_event_id, symbol, ms, epoch });
    this.fingerprint.add({ key: fp, symbol, ms, epoch, stored: o });
    this.enforce();
  }
  pin() { this.pins++; }
  unpin() { this.pins = Math.max(0, this.pins - 1); this.enforce(); }
  get pinned() { return this.pins > 0; }
  get size() { return this.transport.size; }

  /** Upper bound of forgotten evidence for a symbol; occurrences at/before it cannot be proven distinct. */
  evidenceHorizon(symbol: string): number | null { return this.horizon.get(symbol) ?? null; }

  /** Owner declares every entry with source time < throughMs for `symbol` no longer in an active partition. */
  settleThrough(symbol: string, throughMs: number) {
    if (throughMs > (this.settled.get(symbol) ?? -Infinity)) this.settled.set(symbol, throughMs);
    this.enforce();
  }
  /** Retire transport epochs <= epoch: compact metadata replaces per-occurrence transport identity. */
  retireEpochsThrough(epoch: number) {
    if (this.retiredThroughEpoch !== null && epoch <= this.retiredThroughEpoch) return;
    this.transport.retiredThroughEpoch = epoch;
    this.enforce();
  }
  get retiredThroughEpoch() { return this.transport.retiredThroughEpoch; }

  openDependency(d: Omit<RetentionDependency, "id"> & { id?: string }) { return this.reconciliation.open(d); }
  resolveDependency(id: string) { const ok = this.reconciliation.resolve(id); if (ok) this.enforce(); return ok; }

  /** Semantic eligibility. Capacity never appears here. */
  isEligible(e: HotEntry): boolean {
    if (this.pins > 0) return false;
    const settled = this.settled.get(e.symbol);
    if (settled === undefined || !(e.ms < settled)) return false;
    return this.reconciliation.blocking(e.symbol, e.ms).length === 0;
  }

  private forget(e: HotEntry) {
    this.horizon.set(e.symbol, Math.max(this.horizon.get(e.symbol) ?? -Infinity, e.ms));
  }

  private enforce() {
    if (this.pins > 0) { this.check(); return; }
    // Retired transport epochs: stale-epoch protection is carried by compact metadata.
    const retired = this.transport.retiredThroughEpoch;
    if (retired !== null) this.transport.removeWhere((e) => e.epoch <= retired);
    this.transport.evictEligible(this.capacity.transport, (e) => this.isEligible(e)).forEach((e) => this.forget(e));
    this.source.evictEligible(this.capacity.source, (e) => this.isEligible(e)).forEach((e) => this.forget(e));
    this.fingerprint.evictEligible(this.capacity.fingerprint, (e) => this.isEligible(e)).forEach((e) => this.forget(e));
    this.check();
  }

  private check() {
    const over = this.transport.size > this.capacity.transport || this.source.size > this.capacity.source || this.fingerprint.size > this.capacity.fingerprint;
    if (over && !this.pressureNow) this.pressureCount++;
    this.pressureNow = over;
  }

  get metrics(): RetentionMetrics {
    return Object.freeze({
      transport_occurrence_retained: this.transport.size,
      source_identity_retained: this.source.size,
      fingerprint_retained: this.fingerprint.size,
      reconciliation_retained: this.reconciliation.size,
      eligible_eviction_count: this.transport.evicted + this.source.evicted + this.fingerprint.evicted,
      memory_pressure_degradations: this.pressureCount,
      memory_pressure: this.pressureNow,
      unresolved_identity_count: this.reconciliation.unresolved("IDENTITY").length,
      retired_through_epoch: this.transport.retiredThroughEpoch,
      pins: this.pins,
      capacity: this.capacity,
    });
  }
}
