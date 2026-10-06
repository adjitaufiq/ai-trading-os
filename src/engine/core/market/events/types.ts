// M1B.11 — Market Event & Alert Radar contracts.
// kind MARKET_EVENT_OBSERVER, authority NONE. Events ≠ signals: no BUY/SELL, entry, SL/TP, lot, risk or scores.
import type { MarketRegimeSnapshot, MarketRegimeType } from "../regime/types";
import type { MarketApproach, TradingHorizon, TradingStyleContext } from "../horizon/types";
import type { InstitutionalFootprints } from "../institutional-radar/types";

export type MarketEventType =
  | "LIQUIDITY_SWEEP"
  | "STRUCTURE_SHIFT"
  | "REGIME_CHANGE"
  | "HORIZON_CHANGE"
  | "VOLATILITY_EXPANSION"
  | "SNR_INTERACTION"
  | "SESSION_CONTEXT_CHANGE"
  | "REACTION_CONFIRMED"
  | "WATCH_INVALIDATED";

export type EventSeverity = "INFO" | "WATCH" | "IMPORTANT" | "CRITICAL";
export type EventState = "ACTIVE" | "RESOLVED" | "EXPIRED";
export type EventEndReason = "RESOLVED" | "EXPIRED" | null;

export interface MarketEvent {
  readonly eventId: string;
  readonly symbol: string;
  readonly timeframe: string | null;
  readonly type: MarketEventType;
  readonly severity: EventSeverity;
  readonly state: EventState;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly endedReason: EventEndReason;
  readonly occurrenceCount: number;
  readonly lastOccurredAt: number;
  readonly resolvesEventId: string | null;
  readonly context: {
    readonly regime: MarketRegimeType;
    readonly horizon: TradingHorizon;
    readonly approach: MarketApproach;
    readonly footprintTags: readonly string[];
  };
  readonly evidence: readonly string[];
  readonly algorithmVersion: "m1b11-event-v1";
}

/** Factual SNR touch (no fakeout/retest/breakout/role-reversal interpretation). */
export interface SnrInteractionFact {
  levelId: string;
  timeframe: string;
  side: "SUPPORT" | "RESISTANCE";
}

/** One CLOSED-bar observation step. Times are epoch seconds. */
export interface EventObservation {
  symbol: string;
  /** Timeframe of the driving CLOSED bar (bar counter for cooldown/expiry). */
  timeframe: string;
  /** Close time of the driving CLOSED bar; anything observed after this is ignored. */
  barTime: number;
  regime: MarketRegimeSnapshot;
  horizon: TradingStyleContext;
  footprints?: InstitutionalFootprints | null;
  /** Timeframe of the footprint candles (sweep event timeframe). */
  footprintTimeframe?: string;
  snrInteractions?: readonly SnrInteractionFact[];
  /** Injected M1B.7 fact: a reaction was confirmed on this bar. */
  reactionConfirmed?: boolean;
}

export const EVENT_ALGORITHM_VERSION = "m1b11-event-v1" as const;
export { type MarketRegimeSnapshot, type TradingStyleContext };
