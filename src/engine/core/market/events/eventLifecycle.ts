// M1B.11 — pure event constructors/transitions. Every transition returns a NEW frozen revision.
import { EVENT_POLICY } from "./eventPolicy";
import { EVENT_ALGORITHM_VERSION, type MarketEvent, type MarketEventType } from "./types";

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export interface CreateEventArgs {
  symbol: string;
  type: MarketEventType;
  timeframe: string | null;
  at: number;
  context: MarketEvent["context"];
  evidence: readonly string[];
  subject?: string;
  resolvesEventId?: string | null;
}

export function createEvent(a: CreateEventArgs): MarketEvent {
  const p = EVENT_POLICY[a.type];
  if (p.timeframeRequired && !a.timeframe) throw new Error(`${a.type} requires timeframe`);
  if (!p.timeframeRequired && a.type !== "WATCH_INVALIDATED" && a.timeframe !== null) throw new Error(`${a.type} must have timeframe=null`);
  const instant = p.maxActiveBars === 0;
  return deepFreeze({
    eventId: `${a.symbol}:${a.type}:${a.timeframe ?? "NA"}:${a.subject ?? "-"}:${a.at}`,
    symbol: a.symbol, timeframe: a.timeframe, type: a.type, severity: p.severity,
    state: instant ? "RESOLVED" : "ACTIVE",
    createdAt: a.at, endedAt: instant ? a.at : null, endedReason: instant ? "RESOLVED" : null,
    occurrenceCount: 1, lastOccurredAt: a.at,
    resolvesEventId: a.resolvesEventId ?? null,
    context: { ...a.context, footprintTags: [...a.context.footprintTags] },
    evidence: [...a.evidence],
    algorithmVersion: EVENT_ALGORITHM_VERSION,
  } satisfies MarketEvent);
}

export function recordOccurrence(e: MarketEvent, at: number): MarketEvent {
  if (e.state !== "ACTIVE") throw new Error("cannot bump ended event");
  return deepFreeze({ ...e, occurrenceCount: e.occurrenceCount + 1, lastOccurredAt: at });
}

export function endEvent(e: MarketEvent, at: number, reason: "RESOLVED" | "EXPIRED"): MarketEvent {
  if (e.state !== "ACTIVE") throw new Error("event already ended");
  return deepFreeze({ ...e, state: reason, endedAt: at, endedReason: reason });
}
