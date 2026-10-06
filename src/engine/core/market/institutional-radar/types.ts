// M1B.8 — Institutional Footprint Radar contracts.
// PASSIVE evidence layer: probabilistic price footprints only. Never a signal,
// entry trigger, SL/TP/lot/risk modifier, score or setup grade.
import type { ArenaCandle } from "../../normalizer/types";
import type { MarketStructure } from "../../swing/types";

export type FootprintDirection = "BULLISH" | "BEARISH";

export interface InstitutionalRadarInput {
  /** CLOSED candles (running candles are dropped), ascending by timestamp. */
  candles: readonly ArenaCandle[];
  /** Confirmed M15 structure from M1B.3. */
  structure: MarketStructure;
  /** Injected ATR14(M15); the radar never computes ATR itself. */
  atr14M15: number;
}

export interface InstitutionalFootprints {
  sweepDetected: boolean;
  sweepDirection: FootprintDirection | null;
  /** Price distance the wick traded beyond the swept swing (0 when none). */
  sweepWickDistance: number;
  /** Closed bars since the sweep candle (0 = latest closed candle; -1 when none). */
  sweepAgeBars: number;
  displacementPreceded: boolean;
  /** body / atr14M15 of the latest qualifying displacement (0 when none). */
  displacementMagnitude: number;
  insideFVG: boolean;
  activeFVGId: string | null;
  insideOrderBlock: boolean;
  activeOrderBlockId: string | null;
  /** Timestamp of the latest closed candle evaluated. */
  timestamp: number;
}

export interface FVGZone {
  id: string;
  direction: FootprintDirection;
  top: number;
  bottom: number;
  createdAt: number;
  status: "ACTIVE" | "MITIGATED" | "INVALIDATED";
}

export interface OrderBlockZone {
  id: string;
  direction: FootprintDirection;
  high: number;
  low: number;
  createdAt: number;
  status: "ACTIVE" | "INVALIDATED";
}

/** Compact subset persisted in M6 journal rows for M8 research. */
export interface FootprintSnapshot {
  sweepDetected: boolean;
  insideFVG: boolean;
  insideOrderBlock: boolean;
  displacementPreceded: boolean;
}

export const INSTITUTIONAL_RADAR_POLICY_VERSION = "institutional-radar-m1b8-v1";

export const INSTITUTIONAL_RADAR_PARAMS = {
  /** Sweep relevance: sweepAgeBars > this ⇒ sweepDetected=false. */
  SWEEP_TTL_BARS: 3,
  /** Displacement: body > this × ATR14(M15) AND close beyond confirmed M15 swing. */
  DISPLACEMENT_BODY_ATR_MULT: 1.5,
} as const;

export const INSTITUTIONAL_RADAR_RULES = {
  SWEEP: "BULLISH: low < lastConfirmedLow AND close > lastConfirmedLow; BEARISH mirrored; candle after pivot; latest wins; age > 3 ⇒ none",
  DISPLACEMENT: "body/ATR > 1.5 AND close > lastConfirmedHigh (bull) / < lastConfirmedLow (bear); latest qualifying candle",
  FVG: "3-candle: bull c[n-2].high < c[n].low (zone c[n-2].high..c[n].low); bear mirrored; close beyond far edge ⇒ INVALIDATED, else touch ⇒ MITIGATED",
  ORDER_BLOCK: "last opposite candle immediately before a displacement candle that breaks M15 structure; close beyond far edge ⇒ INVALIDATED",
  INSIDE: "latest close within a non-invalidated FVG / ACTIVE OB",
  FORBIDDEN: "no BUY/SELL, no SL/TP/lot/risk, no scoring, no ATR computation",
} as const;

export function toFootprintSnapshot(f: InstitutionalFootprints): FootprintSnapshot {
  return { sweepDetected: f.sweepDetected, insideFVG: f.insideFVG, insideOrderBlock: f.insideOrderBlock, displacementPreceded: f.displacementPreceded };
}
