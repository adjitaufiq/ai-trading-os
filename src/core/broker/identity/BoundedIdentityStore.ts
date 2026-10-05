// PRE-2D Patch C — R7 bounded identity store (Observation Identity owns active identity state).
// FIFO eviction beyond maxEntries, EXCEPT while pinned by an active bootstrap/handoff: then nothing
// is evicted (over-capacity is reported, not hidden). After the last unpin, eviction resumes.
// Eviction only forgets transport identity evidence; it never removes audit log entries.
import type { IdentityStore } from "./ObservationIdentity";

type Stored = Parameters<IdentityStore["add"]>[1];

export interface IdentityRetentionMetrics {
  readonly size: number;
  readonly max_entries: number;
  readonly evicted_total: number;
  readonly pins: number;
  /** Peak entries retained above max_entries because a pin blocked eviction. */
  readonly pinned_overflow_peak: number;
}

export class BoundedIdentityStore implements IdentityStore {
  private readonly order: { fp: string; o: Stored }[] = [];
  private readonly ids = new Map<string, number>();
  private readonly raws = new Map<string, number>();
  private readonly fps = new Map<string, Stored[]>();
  private pins = 0;
  private evicted = 0;
  private overflowPeak = 0;

  constructor(private readonly maxEntries: number) {
    if (!(maxEntries > 0)) throw new Error("maxEntries must be > 0");
  }

  hasObservation(id: string) { return this.ids.has(id); }
  hasRawEvent(r: string) { return this.raws.has(r); }
  byFingerprint(fp: string) { return this.fps.get(fp) ?? []; }

  add(fp: string, o: Stored) {
    this.order.push({ fp, o });
    this.ids.set(o.observation_id, (this.ids.get(o.observation_id) ?? 0) + 1);
    this.raws.set(o.raw_event_id, (this.raws.get(o.raw_event_id) ?? 0) + 1);
    const l = this.fps.get(fp);
    if (l) l.push(o); else this.fps.set(fp, [o]);
    this.enforce();
  }

  pin() { this.pins++; }
  unpin() {
    this.pins = Math.max(0, this.pins - 1);
    this.enforce();
  }
  get pinned() { return this.pins > 0; }
  get size() { return this.order.length; }

  private dec(m: Map<string, number>, k: string) {
    const n = (m.get(k) ?? 1) - 1;
    if (n <= 0) m.delete(k); else m.set(k, n);
  }

  private enforce() {
    if (this.pins > 0) {
      this.overflowPeak = Math.max(this.overflowPeak, this.order.length - this.maxEntries);
      return;
    }
    while (this.order.length > this.maxEntries) {
      const { fp, o } = this.order.shift()!;
      this.dec(this.ids, o.observation_id);
      this.dec(this.raws, o.raw_event_id);
      const l = this.fps.get(fp)!;
      l.splice(l.indexOf(o), 1);
      if (l.length === 0) this.fps.delete(fp);
      this.evicted++;
    }
  }

  get metrics(): IdentityRetentionMetrics {
    return Object.freeze({ size: this.order.length, max_entries: this.maxEntries, evicted_total: this.evicted, pins: this.pins,
      pinned_overflow_peak: Math.max(0, this.overflowPeak) });
  }
}
