import type { ArenaCandle } from "../normalizer/types";
import { calculationLockGate } from "../candle-manager/closedCandleManager";
import type { MarketStructure, StructureShiftType, SwingPoint, SwingTimeframe, TrendStructure } from "./types";

export function classifyTrend(
  latestHigh: SwingPoint | null, previousHigh: SwingPoint | null,
  latestLow: SwingPoint | null, previousLow: SwingPoint | null,
): TrendStructure {
  if (!latestHigh || !previousHigh || !latestLow || !previousLow) return "RANGE";
  if (latestHigh.price > previousHigh.price && latestLow.price > previousLow.price) return "HH_HL";
  if (latestHigh.price < previousHigh.price && latestLow.price < previousLow.price) return "LH_LL";
  return "RANGE";
}

/** Swings must already be confirmed (confirmedAt <= asOf) to be used. */
export function buildStructure(
  symbol: string, timeframe: SwingTimeframe, swings: readonly SwingPoint[], asOf: number,
): MarketStructure {
  const usable = swings
    .filter((s) => s.symbol === symbol && s.timeframe === timeframe && s.confirmedAt <= asOf)
    .sort((a, b) => a.timestamp - b.timestamp);
  const highs = usable.filter((s) => s.type === "HIGH");
  const lows = usable.filter((s) => s.type === "LOW");
  const lastConfirmedHigh = highs.at(-1) ?? null;
  const previousHigh = highs.at(-2) ?? null;
  const lastConfirmedLow = lows.at(-1) ?? null;
  const previousLow = lows.at(-2) ?? null;
  return {
    symbol, timeframe,
    trend: classifyTrend(lastConfirmedHigh, previousHigh, lastConfirmedLow, previousLow),
    lastConfirmedHigh, lastConfirmedLow, previousHigh, previousLow,
    structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: asOf,
  };
}

/** MSS: only a CLOSED candle close beyond the opposing confirmed swing. */
export function detectStructureShift(structure: MarketStructure, candle: ArenaCandle): MarketStructure {
  let shift: StructureShiftType = "NONE";
  if (calculationLockGate(candle).canCalculate && candle.symbol === structure.symbol && candle.timeframe === structure.timeframe) {
    if (structure.trend === "HH_HL" && structure.lastConfirmedLow && candle.close < structure.lastConfirmedLow.price) shift = "BEARISH_MSS";
    else if (structure.trend === "LH_LL" && structure.lastConfirmedHigh && candle.close > structure.lastConfirmedHigh.price) shift = "BULLISH_MSS";
  }
  return { ...structure, structureShift: shift, shiftDetected: shift !== "NONE",
    lastUpdatedTimestamp: Math.max(structure.lastUpdatedTimestamp, candle.timestamp) };
}
