import type { ArenaCandle } from "../../normalizer/types";
import type { FVGZone } from "./types";

/** Deterministic replay of FVG creation + lifecycle over CLOSED candles. */
export function trackFVGs(candles: readonly ArenaCandle[]): FVGZone[] {
  const zones: FVGZone[] = [];
  for (let n = 0; n < candles.length; n++) {
    const c = candles[n]!;
    // lifecycle for zones created strictly before this candle
    for (const z of zones) {
      if (z.status !== "ACTIVE" || z.createdAt >= c.timestamp) continue;
      if (z.direction === "BULLISH") {
        if (c.close < z.bottom) z.status = "INVALIDATED";
        else if (c.low <= z.top) z.status = "MITIGATED";
      } else {
        if (c.close > z.top) z.status = "INVALIDATED";
        else if (c.high >= z.bottom) z.status = "MITIGATED";
      }
    }
    if (n < 2) continue;
    const a = candles[n - 2]!;
    if (a.high < c.low) zones.push({ id: `${c.symbol}_${c.timeframe}_FVG_BULLISH_${c.timestamp}`, direction: "BULLISH", top: c.low, bottom: a.high, createdAt: c.timestamp, status: "ACTIVE" });
    else if (a.low > c.high) zones.push({ id: `${c.symbol}_${c.timeframe}_FVG_BEARISH_${c.timestamp}`, direction: "BEARISH", top: a.low, bottom: c.high, createdAt: c.timestamp, status: "ACTIVE" });
  }
  return zones;
}
