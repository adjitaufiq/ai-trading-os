// Pre-execution SAFETY checks only. Nothing here sends or prepares an order.
import { RISK_PARAMS as P } from "./types";

export interface SpreadCheck { ok: boolean; sma: number | null; hardCap: number | null; detail: string }

export function checkSpread(symbol: string, current: number, history: readonly number[], hardCaps: Readonly<Record<string, number>> = P.SPREAD_HARD_CAP): SpreadCheck {
  const cap = hardCaps[symbol] ?? null;
  const recent = history.slice(-P.SPREAD_SMA_PERIOD);
  const sma = recent.length >= P.SPREAD_SMA_PERIOD ? recent.reduce((s, x) => s + x, 0) / recent.length : null;
  if (cap !== null && current > cap) return { ok: false, sma, hardCap: cap, detail: `spread ${current} > hard cap ${cap}` };
  if (sma !== null && current > sma * P.SPREAD_SMA_MULTIPLIER) return { ok: false, sma, hardCap: cap, detail: `spread ${current} > SMA20 ${sma.toFixed(5)}×${P.SPREAD_SMA_MULTIPLIER}` };
  return { ok: true, sma, hardCap: cap, detail: sma === null ? "SMA20 skipped (<20 samples)" : "within limits" };
}

export interface SlippageCheck { ok: boolean; slippage: number; detail: string }

export function checkSlippage(direction: "BUY" | "SELL", plannedEntry: number, ask: number, bid: number, maxAllowed: number): SlippageCheck {
  const ref = direction === "BUY" ? ask : bid;
  const slippage = Math.abs(ref - plannedEntry);
  return { ok: slippage <= maxAllowed + 1e-12, slippage, detail: `${direction} ref=${ref} planned=${plannedEntry} slip=${slippage} max=${maxAllowed}` };
}

export function checkMargin(lot: number, marginPerLot: number, freeMargin: number): boolean {
  return lot * marginPerLot <= freeMargin;
}
