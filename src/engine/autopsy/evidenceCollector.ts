import type { JournalTrade } from "../journal/types";
import { AUTOPSY_PARAMS as P, type AutopsyEvidence, type AutopsyMarketData, type Ohlc, type PostTradeMovement } from "./types";

const r4 = (n: number) => Math.round(n * 10000) / 10000;
export const riskDistance = (t: JournalTrade) => Math.abs(t.entryPrice - t.stopLoss);
const ev = (metric: string, expected: string, actual: string, passed: boolean): AutopsyEvidence => ({ metric, expected, actual, passed });

/** Movement after close, measured from entry (price units). */
export function analyzeAfterTrade(t: JournalTrade, future: readonly Ohlc[]): PostTradeMovement {
  if (!future.length) return { maxMoveAgainst: 0, maxMoveInFavor: 0, returnedToEntry: false, continuedDirection: false };
  const hi = Math.max(...future.map((b) => b.high)), lo = Math.min(...future.map((b) => b.low));
  const buy = t.direction === "BUY";
  const favor = buy ? hi - t.entryPrice : t.entryPrice - lo;
  const against = buy ? t.entryPrice - lo : hi - t.entryPrice;
  const returned = buy ? hi >= t.entryPrice && lo <= t.entryPrice || (t.exitPrice < t.entryPrice ? hi >= t.entryPrice : lo <= t.entryPrice)
                       : lo <= t.entryPrice && hi >= t.entryPrice || (t.exitPrice > t.entryPrice ? lo <= t.entryPrice : hi >= t.entryPrice);
  return { maxMoveAgainst: r4(Math.max(0, against)), maxMoveInFavor: r4(Math.max(0, favor)), returnedToEntry: returned, continuedDirection: favor >= Math.abs(t.takeProfit - t.entryPrice) };
}

export const locationValid = (t: JournalTrade) => !P.INVALID_LOCATIONS.includes(t.context.priceLocation) && t.context.locationTier !== "NO_TIER";

export function biasConflict(t: JournalTrade): boolean {
  const b = t.context.bias.toUpperCase();
  const htf = b.includes("BULLISH") ? "BUY" : b.includes("BEARISH") ? "SELL" : null;
  return htf !== null && htf !== t.direction && P.STRONG_H1_PHASES.includes(t.context.h1Phase.toUpperCase());
}

export function locationEvidence(t: JournalTrade): AutopsyEvidence {
  return ev("LOCATION_VALID", "Tier location (not MID_RANGE / NO_TIER)", `${t.context.priceLocation} / ${t.context.locationTier}`, locationValid(t));
}

export function biasEvidence(t: JournalTrade): AutopsyEvidence {
  return ev("BIAS_ALIGNMENT", "Direction not against strong HTF context", `${t.direction} vs ${t.context.bias} | ${t.context.h1Phase}`, !biasConflict(t));
}

export function volatilityEvidence(m: AutopsyMarketData): AutopsyEvidence[] {
  const out: AutopsyEvidence[] = [];
  if (m.atr !== null && m.atr > 0 && m.tradeBars.length) {
    const maxRange = Math.max(...m.tradeBars.map((b) => b.high - b.low));
    out.push(ev("CANDLE_SIZE_ATR", `< ${P.VOLATILITY_CANDLE_ATR}× ATR`, `${r4(maxRange / m.atr)}× ATR`, maxRange / m.atr < P.VOLATILITY_CANDLE_ATR));
  }
  if (m.spreadAtEntry !== undefined && m.normalSpread !== undefined && m.normalSpread > 0) {
    const x = m.spreadAtEntry / m.normalSpread;
    out.push(ev("SPREAD_RATIO", `< ${P.VOLATILITY_SPREAD_MULT}× normal`, `${r4(x)}× normal`, x < P.VOLATILITY_SPREAD_MULT));
  }
  return out;
}

export function executionEvidence(t: JournalTrade, m: AutopsyMarketData): AutopsyEvidence[] {
  if (!m.execution) return [];
  const R = riskDistance(t);
  const dev = Math.abs(m.execution.actualEntry - m.execution.plannedEntry);
  const devR = R > 0 ? dev / R : 0;
  return [
    ev("FILL_DEVIATION_R", `< ${P.EXECUTION_FILL_DEVIATION_R}R`, `${r4(devR)}R (${r4(dev)})`, devR < P.EXECUTION_FILL_DEVIATION_R),
    ev("LATENCY_MS", `< ${P.EXECUTION_MAX_LATENCY_MS}ms`, `${m.execution.latencyMs}ms`, m.execution.latencyMs < P.EXECUTION_MAX_LATENCY_MS),
  ];
}

export function sweepEvidence(t: JournalTrade, m: AutopsyMarketData): AutopsyEvidence[] {
  const fut = m.futureCandles.slice(0, P.SWEEP_LOOKAHEAD_BARS);
  if (t.closeReason !== "SL_HIT" || !fut.length) return [];
  const R = riskDistance(t);
  const buy = t.direction === "BUY";
  const rec = buy ? Math.max(...fut.map((b) => b.high)) - t.stopLoss : t.stopLoss - Math.min(...fut.map((b) => b.low));
  const recR = R > 0 ? rec / R : 0;
  const beyondEntry = buy ? Math.max(...fut.map((b) => b.high)) > t.entryPrice : Math.min(...fut.map((b) => b.low)) < t.entryPrice;
  return [
    ev("SL_VIOLATED", "SL hit", t.closeReason, true),
    // passed=false means the stop was swept: price did NOT continue after SL.
    ev("PRICE_RETURN_AFTER_SL", "Price should continue after SL", `Price moved +${r4(recR)}R after SL within ${fut.length} bars`, recR < P.SWEEP_MIN_RECOVERY_R),
    ev("RECOVERED_BEYOND_ENTRY", "Price stays beyond SL side", beyondEntry ? "Recovered beyond entry" : "Did not reach entry", !beyondEntry),
  ];
}

export function triggerEvidence(t: JournalTrade, m: AutopsyMarketData): AutopsyEvidence[] {
  if (t.closeReason !== "SL_HIT" || !m.tradeBars.length) return [];
  const R = riskDistance(t);
  const buy = t.direction === "BUY";
  const favor = buy ? Math.max(...m.tradeBars.map((b) => b.high)) - t.entryPrice : t.entryPrice - Math.min(...m.tradeBars.map((b) => b.low));
  const favorR = R > 0 ? Math.max(0, favor) / R : 0;
  const immediate = m.tradeBars.length <= P.TRIGGER_IMMEDIATE_BARS && favorR < P.TRIGGER_MAX_FAVOR_R;
  return [ev("TRIGGER_FOLLOW_THROUGH", `≥ ${P.TRIGGER_MAX_FAVOR_R}R in favor or > ${P.TRIGGER_IMMEDIATE_BARS} bars`, `${r4(favorR)}R in ${m.tradeBars.length} bars`, !immediate)];
}
