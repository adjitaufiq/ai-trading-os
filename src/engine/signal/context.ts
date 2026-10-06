// M2 context envelope (m2-context-v1): OBSERVATIONAL metadata from M1B.8–M1B.11.
// Authority NONE: never read by evaluator, lifecycle, plan, risk or execution.
// Footprint ≠ Signal, Regime ≠ Signal, Horizon ≠ Signal, Event ≠ Signal.
import type { MarketRegimeSnapshot } from "../core/market/regime/types";
import type { TradingStyleContext } from "../core/market/horizon/types";
import type { InstitutionalFootprints } from "../core/market/institutional-radar/types";
import type { EventSeverity, EventState, MarketEvent, MarketEventType } from "../core/market/events/types";

export const MARKET_CONTEXT_VERSION = "m2-context-v1" as const;

export interface EventReference {
  readonly eventId: string;
  readonly type: MarketEventType;
  readonly severity: EventSeverity;
  readonly state: EventState;
  readonly timeframe: string | null;
}

export interface MarketContextSnapshot {
  readonly regime: MarketRegimeSnapshot | null;
  readonly horizon: TradingStyleContext | null;
  readonly footprints: InstitutionalFootprints | null;
  readonly activeEvents: readonly EventReference[];
  readonly capturedAt: number;
  readonly contextVersion: typeof MARKET_CONTEXT_VERSION;
}

/** Raw sources supplied by the caller; may be mutable — they are deep-copied. */
export interface MarketContextSources {
  regime?: MarketRegimeSnapshot | null;
  horizon?: TradingStyleContext | null;
  footprints?: InstitutionalFootprints | null;
  /** Event revisions (e.g. EventStore snapshot); only references are kept. */
  events?: readonly MarketEvent[];
}

function deepCopyFreeze<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  const out: any = Array.isArray(v) ? v.map(deepCopyFreeze) : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, deepCopyFreeze(x)]));
  return Object.freeze(out);
}

/**
 * Causal capture at `capturedAt`: sources stamped after capturedAt are dropped
 * (null), events must be created ≤ capturedAt and still active at capturedAt.
 * Output is a deep-frozen copy with no shared references.
 */
export function captureMarketContext(src: MarketContextSources, capturedAt: number): MarketContextSnapshot {
  const regime = src.regime && src.regime.asOf <= capturedAt ? src.regime : null;
  const horizon = src.horizon && src.horizon.asOf <= capturedAt ? src.horizon : null;
  const footprints = src.footprints && src.footprints.timestamp <= capturedAt ? src.footprints : null;
  const activeEvents: EventReference[] = (src.events ?? [])
    .filter((e) => e.createdAt <= capturedAt && (e.endedAt === null || e.endedAt > capturedAt))
    .map((e) => ({ eventId: e.eventId, type: e.type, severity: e.severity, state: "ACTIVE" as const, timeframe: e.timeframe }))
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  return deepCopyFreeze({ regime, horizon, footprints, activeEvents, capturedAt, contextVersion: MARKET_CONTEXT_VERSION });
}

/** Descriptive tag list from footprints (used by M6 journal). */
export function footprintTags(f: InstitutionalFootprints | null): string[] {
  if (!f) return [];
  const t: string[] = [];
  if (f.sweepDetected) t.push(`SWEEP_${f.sweepDirection ?? "UNKNOWN"}`);
  if (f.displacementPreceded) t.push("DISPLACEMENT");
  if (f.insideFVG) t.push("INSIDE_FVG");
  if (f.insideOrderBlock) t.push("INSIDE_OB");
  return t;
}
