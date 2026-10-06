// M7 per-asset synthetic profiles. Volatility multipliers are PRIOR EXPECTATIONS for the generator only
// (labelled SIMULATION), never strategy params and never read by any engine.
import { defaultSymbolRegistry } from "../contracts/symbols";
import type { AssetClass } from "../contracts/symbols";
import type { MarketSession } from "../../core/temporal/MarketSessionResolver";
import { STRESS_ENV as E } from "./types";

export interface AssetProfile {
  symbol: string;
  assetClass: AssetClass;
  basePrice: number;
  point: number;
  /** Multiplier on the XAU-scaled generator moves (price-level scaling). */
  priceScale: number;
  sessionVolatility: Readonly<Record<MarketSession, number>>;
  /** Reopen gap size in sigma units (XAU after weekly close). */
  reopenGapSigma: number;
  /** Per-bar probability of a weekend liquidity cascade (BTC). */
  weekendCascadeProb: number;
  contract: { volumeMin: number; volumeMax: number; volumeStep: number; tickSize: number; tickValue: number; marginPerLot: number };
}

const xau = defaultSymbolRegistry.require("XAUUSD");
const btc = defaultSymbolRegistry.require("BTCUSD");

export const ASSET_PROFILES: Readonly<Record<string, AssetProfile>> = Object.freeze({
  XAUUSD: {
    symbol: "XAUUSD", assetClass: xau.assetClass, basePrice: 2650, point: xau.point, priceScale: 1,
    sessionVolatility: { ASIA: 0.7, LONDON: 1.1, NY: 1.3, OVERNIGHT: 0.8, WEEKEND: 1, MARKET_CLOSED: 0 },
    reopenGapSigma: 3, weekendCascadeProb: 0, contract: { ...E.BROKER },
  },
  BTCUSD: {
    symbol: "BTCUSD", assetClass: btc.assetClass, basePrice: 65000, point: btc.point, priceScale: 65000 / 2650,
    sessionVolatility: { ASIA: 1, LONDON: 1, NY: 1.2, OVERNIGHT: 0.9, WEEKEND: 0.8, MARKET_CLOSED: 0 },
    reopenGapSigma: 0, weekendCascadeProb: 0.01,
    contract: { volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: btc.tick_size, tickValue: btc.tick_size * btc.contract_size, marginPerLot: 1000 },
  },
});

export const profileOf = (symbol: string): AssetProfile | undefined => ASSET_PROFILES[symbol.toUpperCase()];
