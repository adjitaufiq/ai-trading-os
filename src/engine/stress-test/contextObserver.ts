// M7 context sensors — wires EXISTING M1B.8/9/10/11 engines as passive observers
// on the same CLOSED-bar stream. Authority NONE: output only feeds
// SignalSetup.marketContext (m2-context-v1) and descriptive stats; it is never
// passed to evaluateSetup/updateSetup/plan/risk/execution.
import type { EMAContext } from "../core/ema/types";
import type { PriceContext } from "../core/location/types";
import { MarketEventEngine } from "../core/market/events/eventEngine";
import type { MarketEvent, SnrInteractionFact } from "../core/market/events/types";
import { classifyHorizon } from "../core/market/horizon/horizonClassifier";
import type { M5MomentumObservation, TradingStyleContext } from "../core/market/horizon/types";
import { scanInstitutionalFootprints } from "../core/market/institutional-radar/institutionalRadar";
import type { InstitutionalFootprints } from "../core/market/institutional-radar/types";
import { classifyRegime } from "../core/market/regime/regimeClassifier";
import type { MarketRegimeSnapshot } from "../core/market/regime/types";
import type { ArenaCandle } from "../core/normalizer/types";
import type { MarketStructure } from "../core/swing/types";
import type { MarketContextSources } from "../signal/context";
import { bump } from "./performanceMonitor";
import { STRESS_ENV as E, type ContextCounters } from "./types";

export interface ObserveInput {
  symbol: string; now: number; m15: readonly ArenaCandle[]; m15Structure: MarketStructure;
  h4Structure: MarketStructure; h1Structure: MarketStructure; atr: number;
  ema: EMAContext; price: PriceContext; reactionConfirmed: boolean;
}

export function emptyContextCounters(): ContextCounters {
  return { observedBars: 0, regime: {}, horizon: {}, regimeFlips: 0, eventsCreated: {}, eventsEnded: {}, maxTrackers: 0, revisions: 0, causalityViolations: 0, footprintBars: {} };
}

/** Injected M5 momentum sign (M1B.10 contract): EMA21 slope of the closed-M5 EMA context. */
const momentumOf = (e: EMAContext): M5MomentumObservation => (e.slope21 === "RISING" ? "BULLISH" : e.slope21 === "FALLING" ? "BEARISH" : "NONE");

export class ContextObserver {
  readonly events = new MarketEventEngine();
  private readonly atrHistory: number[] = [];
  private readonly seen = new Set<string>();
  private lastRegime: string | null = null;
  current: { regime: MarketRegimeSnapshot; horizon: TradingStyleContext; footprints: InstitutionalFootprints } | null = null;

  constructor(private readonly counters: ContextCounters) {}

  observe(i: ObserveInput): void {
    const regime = classifyRegime({ symbol: i.symbol, now: i.now, h4Structure: i.h4Structure, h1Structure: i.h1Structure, m15Atr: i.atr, historicalAtrList: [...this.atrHistory] });
    this.atrHistory.push(i.atr); if (this.atrHistory.length > E.ATR_HISTORY) this.atrHistory.shift();
    const footprints = scanInstitutionalFootprints({ candles: i.m15, structure: i.m15Structure, atr14M15: i.atr });
    const horizon = classifyHorizon({ symbol: i.symbol, now: i.now, regime, m15Structure: i.m15Structure, m5Momentum: momentumOf(i.ema), footprints });
    const snr: SnrInteractionFact[] = i.price.priceLocation === "AT_SUPPORT" || i.price.priceLocation === "AT_RESISTANCE"
      ? [{ levelId: `M15@${i.price.keyLevelPrice}`, timeframe: "M15", side: i.price.priceLocation === "AT_SUPPORT" ? "SUPPORT" : "RESISTANCE" }] : [];
    const revs = this.events.step({ symbol: i.symbol, timeframe: "M5", barTime: i.now, regime, horizon, footprints, footprintTimeframe: "M15", snrInteractions: snr, reactionConfirmed: i.reactionConfirmed });

    const c = this.counters;
    c.observedBars++;
    bump(c.regime, regime.regime); bump(c.horizon, horizon.recommendedHorizon);
    if (this.lastRegime !== null && this.lastRegime !== regime.regime) c.regimeFlips++;
    this.lastRegime = regime.regime;
    if (footprints.sweepDetected) bump(c.footprintBars, "SWEEP");
    if (footprints.displacementPreceded) bump(c.footprintBars, "DISPLACEMENT");
    for (const e of revs) {
      if (e.occurrenceCount === 1 && e.createdAt === i.now && (e.state === "ACTIVE" || e.endedAt === i.now) && !this.seen.has(e.eventId) && this.seen.add(e.eventId)) bump(c.eventsCreated, e.type);
      if (e.state !== "ACTIVE") bump(c.eventsEnded, `${e.type}:${e.endedReason}`);
      if (e.createdAt > i.now) c.causalityViolations++;
    }
    if (regime.asOf > i.now || horizon.asOf > i.now || footprints.timestamp > i.now) c.causalityViolations++;
    c.maxTrackers = Math.max(c.maxTrackers, this.events.trackerCount(i.symbol));
    c.revisions = this.events.store.revisionCount();
    this.current = { regime, horizon, footprints };
  }

  sources(symbol: string): MarketContextSources | undefined {
    if (!this.current) return undefined;
    return { ...this.current, events: this.events.store.getActiveEvents(symbol) as MarketEvent[] };
  }
}
