import type { ExposureLimits, OpenPositionExposure } from "./types";

export interface ExposureCheck { ok: boolean; symbolRiskUSD: number; totalRiskUSD: number; remainingUSD: number }

/** All open positions on the same symbol are clustered as one exposure. */
export function checkExposure(symbol: string, positions: readonly OpenPositionExposure[], limits: ExposureLimits, newRiskUSD = 0): ExposureCheck {
  const symbolRisk = positions.filter((p) => p.symbol === symbol).reduce((s, p) => s + p.riskUSD, 0);
  const totalRisk = positions.reduce((s, p) => s + p.riskUSD, 0);
  const remaining = Math.max(0, Math.min(limits.maxSymbolRiskUSD - symbolRisk, limits.maxTotalRiskUSD - totalRisk));
  const ok = symbolRisk + newRiskUSD <= limits.maxSymbolRiskUSD + 1e-9 && totalRisk + newRiskUSD <= limits.maxTotalRiskUSD + 1e-9;
  return { ok, symbolRiskUSD: symbolRisk, totalRiskUSD: totalRisk, remainingUSD: remaining };
}
