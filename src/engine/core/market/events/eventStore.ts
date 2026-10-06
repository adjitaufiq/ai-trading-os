// M1B.11 — IN_MEMORY_APPEND_ONLY_EVENT_STORE. Revisions are appended, never mutated.
// No database, no network, no broker. Storage adapters may replace this later without changing event logic.
import { deepFreeze } from "./eventLifecycle";
import type { EventState, MarketEvent, MarketEventType } from "./types";

interface Revision { readonly event: MarketEvent; readonly recordedAt: number; }

export interface EventQuery {
  symbol?: string;
  type?: MarketEventType;
  state?: EventState;
  timeframe?: string | null;
  from?: number;
  to?: number;
}

export interface EventSnapshot {
  readonly asOf: number;
  readonly algorithmVersion: "m1b11-event-v1";
  readonly events: readonly MarketEvent[];
}

const order = (a: MarketEvent, b: MarketEvent) => a.createdAt - b.createdAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);

export class InMemoryEventStore {
  private readonly log: Revision[] = [];
  private readonly latest = new Map<string, MarketEvent>();

  /** Appends a frozen revision. recordedAt must be monotonic (causal). */
  saveEvent(event: MarketEvent, recordedAt: number): void {
    const last = this.log.at(-1);
    if (last && recordedAt < last.recordedAt) throw new Error("non-monotonic recordedAt");
    const prev = this.latest.get(event.eventId);
    if (prev && prev.state !== "ACTIVE") throw new Error("ended event is immutable");
    const frozen = deepFreeze(structuredClone(event));
    this.log.push(Object.freeze({ event: frozen, recordedAt }));
    this.latest.set(event.eventId, frozen);
  }

  getEvent(eventId: string): MarketEvent | null { return this.latest.get(eventId) ?? null; }

  queryEvents(q: EventQuery = {}): readonly MarketEvent[] {
    return [...this.latest.values()].filter((e) =>
      (q.symbol === undefined || e.symbol === q.symbol) &&
      (q.type === undefined || e.type === q.type) &&
      (q.state === undefined || e.state === q.state) &&
      (q.timeframe === undefined || e.timeframe === q.timeframe) &&
      (q.from === undefined || e.createdAt >= q.from) &&
      (q.to === undefined || e.createdAt <= q.to)).sort(order);
  }

  getActiveEvents(symbol?: string): readonly MarketEvent[] { return this.queryEvents({ symbol, state: "ACTIVE" }); }

  revisionCount(): number { return this.log.length; }

  /** Deterministic: latest revision per event with recordedAt <= asOf, sorted by createdAt/eventId. */
  exportSnapshot(asOf: number): EventSnapshot {
    const m = new Map<string, MarketEvent>();
    for (const r of this.log) { if (r.recordedAt > asOf) break; m.set(r.event.eventId, r.event); }
    return deepFreeze({ asOf, algorithmVersion: "m1b11-event-v1", events: [...m.values()].sort(order) });
  }
}
