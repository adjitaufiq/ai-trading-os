// M1B.11 — per-type event policy. No universal expiry; every type owns its lifecycle.
import type { EventSeverity, MarketEventType } from "./types";

export interface EventTypePolicy {
  /** Repeat within this many driving bars of last occurrence ⇒ bump occurrenceCount, no new event. */
  readonly cooldownBars: number;
  /** ACTIVE longer than this many driving bars ⇒ EXPIRED. null = ends only by resolution. */
  readonly maxActiveBars: number | null;
  /** Expiry emits WATCH_INVALIDATED. */
  readonly watchOnExpiry: boolean;
  readonly timeframeRequired: boolean;
  readonly severity: EventSeverity;
}

export const EVENT_POLICY: Readonly<Record<MarketEventType, EventTypePolicy>> = Object.freeze({
  LIQUIDITY_SWEEP:        { cooldownBars: 3,  maxActiveBars: 20,   watchOnExpiry: true,  timeframeRequired: true,  severity: "IMPORTANT" },
  STRUCTURE_SHIFT:        { cooldownBars: 3,  maxActiveBars: 20,   watchOnExpiry: false, timeframeRequired: true,  severity: "IMPORTANT" },
  REGIME_CHANGE:          { cooldownBars: 10, maxActiveBars: null, watchOnExpiry: false, timeframeRequired: false, severity: "IMPORTANT" },
  HORIZON_CHANGE:         { cooldownBars: 10, maxActiveBars: null, watchOnExpiry: false, timeframeRequired: false, severity: "WATCH" },
  VOLATILITY_EXPANSION:   { cooldownBars: 6,  maxActiveBars: 24,   watchOnExpiry: false, timeframeRequired: true,  severity: "CRITICAL" },
  SNR_INTERACTION:        { cooldownBars: 3,  maxActiveBars: 12,   watchOnExpiry: true,  timeframeRequired: true,  severity: "WATCH" },
  SESSION_CONTEXT_CHANGE: { cooldownBars: 1,  maxActiveBars: null, watchOnExpiry: false, timeframeRequired: false, severity: "INFO" },
  REACTION_CONFIRMED:     { cooldownBars: 0,  maxActiveBars: 0,    watchOnExpiry: false, timeframeRequired: true,  severity: "IMPORTANT" },
  WATCH_INVALIDATED:      { cooldownBars: 0,  maxActiveBars: 0,    watchOnExpiry: false, timeframeRequired: false, severity: "INFO" },
});

export const EVENT_RULES = {
  DEDUP: "same symbol+type+timeframe+subject within cooldownBars of last occurrence: ACTIVE ⇒ occurrenceCount+1; ended ⇒ suppressed",
  RESOLUTION: "REACTION_CONFIRMED resolves the latest ACTIVE LIQUIDITY_SWEEP / SNR_INTERACTION of the symbol (resolvesEventId)",
  EXPIRY: "ACTIVE for >= maxActiveBars driving bars ⇒ EXPIRED; watchOnExpiry ⇒ WATCH_INVALIDATED(resolvesEventId)",
  SUPERSEDE: "new REGIME_CHANGE/HORIZON_CHANGE resolves the previous ACTIVE one; VOLATILITY_EXPANSION resolves when volatility leaves EXPANSION",
  TEMPORAL: "inputs with asOf/timestamp > barTime are ignored",
  FORBIDDEN: "no BUY/SELL, signal, entry timing, SL/TP, lot, risk, score, confidence or probability",
} as const;
