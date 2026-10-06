import type { ArenaCandle } from "../../normalizer/types";
import type { MarketStructure } from "../../swing/types";
import { INSTITUTIONAL_RADAR_PARAMS as P, type FootprintDirection, type OrderBlockZone } from "./types";

/** Displacement direction of a candle, or null. Requires body > mult×ATR AND close beyond confirmed swing. */
export function displacementOf(c: ArenaCandle, s: MarketStructure, atr: number): FootprintDirection | null {
  if (!(atr > 0)) return null;
  const body = Math.abs(c.close - c.open);
  if (body / atr <= P.DISPLACEMENT_BODY_ATR_MULT) return null;
  if (c.close > c.open && s.lastConfirmedHigh && c.close > s.lastConfirmedHigh.price && c.timestamp > s.lastConfirmedHigh.timestamp) return "BULLISH";
  if (c.close < c.open && s.lastConfirmedLow && c.close < s.lastConfirmedLow.price && c.timestamp > s.lastConfirmedLow.timestamp) return "BEARISH";
  return null;
}

/** Strict OB: the opposite candle IMMEDIATELY before a structure-breaking displacement. */
export function detectOrderBlocks(candles: readonly ArenaCandle[], s: MarketStructure, atr: number): OrderBlockZone[] {
  const obs: OrderBlockZone[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    for (const ob of obs) {
      if (ob.status !== "ACTIVE" || ob.createdAt >= c.timestamp) continue;
      if (ob.direction === "BULLISH" ? c.close < ob.low : c.close > ob.high) ob.status = "INVALIDATED";
    }
    if (i === 0) continue;
    const d = displacementOf(c, s, atr);
    const prev = candles[i - 1];
    if (d === "BULLISH" && prev.close < prev.open)
      obs.push({ id: `${c.symbol}_${c.timeframe}_OB_BULLISH_${prev.timestamp}`, direction: "BULLISH", high: prev.high, low: prev.low, createdAt: c.timestamp, status: "ACTIVE" });
    else if (d === "BEARISH" && prev.close > prev.open)
      obs.push({ id: `${c.symbol}_${c.timeframe}_OB_BEARISH_${prev.timestamp}`, direction: "BEARISH", high: prev.high, low: prev.low, createdAt: c.timestamp, status: "ACTIVE" });
  }
  return obs;
}
