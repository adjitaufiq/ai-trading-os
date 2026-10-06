// M1B.3 — Anti-repaint swing detector & market structure engine contracts.
// Consumes ONLY CLOSED ArenaCandles (gated by M1B.2 calculationLockGate).

export type SwingType = "HIGH" | "LOW";
export type SwingStrength = "WEAK" | "NORMAL" | "STRONG";
export type TrendStructure = "HH_HL" | "LH_LL" | "RANGE";
export type StructureShiftType = "NONE" | "BULLISH_MSS" | "BEARISH_MSS";

/** M5 is NOT allowed as a swing anchor. */
export type SwingTimeframe = "M15" | "H1" | "H4";
export const SWING_TIMEFRAMES: readonly SwingTimeframe[] = ["M15", "H1", "H4"];

export interface SwingPoint {
  id: string;
  symbol: string;
  timeframe: SwingTimeframe;
  type: SwingType;
  price: number;
  /** Pivot candle open time (epoch seconds). */
  timestamp: number;
  /** Close time of the last right-bar candle (epoch seconds). */
  confirmedAt: number;
  strength: SwingStrength;
  leftBars: number;
  rightBars: number;
  rejectionWickRatio: number;
}

export interface MarketStructure {
  symbol: string;
  timeframe: SwingTimeframe;
  trend: TrendStructure;
  lastConfirmedHigh: SwingPoint | null;
  lastConfirmedLow: SwingPoint | null;
  previousHigh: SwingPoint | null;
  previousLow: SwingPoint | null;
  structureShift: StructureShiftType;
  shiftDetected: boolean;
  lastUpdatedTimestamp: number;
}

export const SWING_POLICY_VERSION = "swing-m1b3-v1";
export const SWING_PARAMS = {
  LEFT_BARS: 2,
  RIGHT_BARS: 2,
  STRONG_WICK_RATIO: 0.5,
  NORMAL_WICK_RATIO: 0.2,
} as const;

/** Timeframe roles (documentation + lookup for downstream engines). */
export const TIMEFRAME_ROLE: Record<SwingTimeframe, readonly string[]> = {
  H4: ["MACRO_TREND_BIAS"],
  H1: ["MACRO_TREND_BIAS"],
  M15: ["STRUCTURE", "SUPPORT_RESISTANCE", "SL_ANCHOR"],
};
