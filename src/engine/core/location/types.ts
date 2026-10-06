// M1B.5 — Price location engine & key level classifier contracts.
// Consumes ONLY confirmed M15 MarketStructure (M1B.3), MarketBiasState (M1B.4)
// and CLOSED ArenaCandles. No EMA/RSI/entry/SL/TP/signals.

export type PriceLocation =
  | "AT_SUPPORT"
  | "AT_RESISTANCE"
  | "AT_SUPPLY_DEMAND"
  | "NEAR_EMA21"
  | "NEAR_EMA50"
  | "BREAKOUT_WAITING"
  | "MID_RANGE";

export type PriceLocationTier = "TIER_1_CORE" | "TIER_2_DYNAMIC" | "TIER_3_PENDING" | "NO_TIER";

export type RangePosition = "LOWER_RANGE" | "MID_RANGE" | "UPPER_RANGE";

export interface PriceContext {
  currentPrice: number;
  priceLocation: PriceLocation;
  locationTier: PriceLocationTier;
  keyLevelPrice: number;
  distanceToLevel: number;
  distancePercent: number;
  nearestLevelType: "SUPPORT" | "RESISTANCE" | "NONE";
  rangePosition: RangePosition;
  description: string;
  lastUpdated: number;
}

export const LOCATION_POLICY_VERSION = "location-m1b5-v1";

export const LOCATION_PARAMS = {
  ATR_PERIOD: 14,
  /** Reaction-side proximity to a confirmed M15 swing level. */
  AT_LEVEL_ATR_MULT: 0.25,
  /** Max pierce beyond a level (no CLOSED break yet) to count as BREAKOUT_WAITING. */
  BREAKOUT_WAITING_ATR_MULT: 0.15,
  /** Range split into thirds. */
  RANGE_LOWER_BOUND: 1 / 3,
  RANGE_UPPER_BOUND: 2 / 3,
} as const;

export const LOCATION_RULES = {
  LEVEL_SOURCE: "M15 confirmed swings only: support=lastConfirmedLow, resistance=lastConfirmedHigh",
  PRIORITY: ["AT_SUPPORT", "AT_RESISTANCE", "AT_SUPPLY_DEMAND", "BREAKOUT_WAITING", "MID_RANGE"],
  AT_SUPPORT: "price >= support AND price - support <= 0.25*ATR14(M15 closed)",
  AT_RESISTANCE: "price <= resistance AND resistance - price <= 0.25*ATR14(M15 closed)",
  BREAKOUT_WAITING: "price beyond level by <= 0.15*ATR14 AND last CLOSED M15 candle has not closed beyond the level",
  MID_RANGE: "anything else; not an entry location",
  AT_SUPPLY_DEMAND: "no supply/demand source defined yet — never emitted in v1",
  EMA: "NEAR_EMA21/NEAR_EMA50 reserved for M1B.6 — never emitted in v1",
} as const;
