import { RISK_PARAMS as P, type BrokerSymbolInfo, type PositionSizeResult } from "./types";

const decimals = (step: number) => { const s = String(step); return s.includes(".") ? (s.split(".")[1] ?? "").length : 0; };

/** Always FLOOR to volumeStep; never round. */
export function floorToStep(lot: number, step: number): number {
  const n = Math.floor(lot / step + P.FLOOR_EPSILON) * step;
  return Number(n.toFixed(decimals(step)));
}

export function lossPerLotUSD(slDistance: number, b: BrokerSymbolInfo): number {
  return (slDistance / b.tickSize) * b.tickValue;
}

/**
 * strict=true: below-minimum lot stays below (caller BLOCKS).
 * strict=false: forced to volumeMin, with real risk/deviation reported.
 */
export function calculatePositionSize(budgetUSD: number, slDistance: number, b: BrokerSymbolInfo, strict: boolean): PositionSizeResult | null {
  if (!(budgetUSD >= 0 && slDistance > 0 && b.tickSize > 0 && b.tickValue > 0 && b.volumeStep > 0)) return null;
  const perLot = lossPerLotUSD(slDistance, b);
  const rawLot = budgetUSD / perLot;
  let finalLot = Math.min(floorToStep(rawLot, b.volumeStep), floorToStep(b.volumeMax, b.volumeStep));
  let forced = false;
  if (finalLot < b.volumeMin && !strict) { finalLot = b.volumeMin; forced = true; }
  const actual = Math.round(finalLot * perLot * 100) / 100;
  const dev = budgetUSD > 0 ? Math.round(((actual - budgetUSD) / budgetUSD) * 10000) / 100 : 0;
  return Object.freeze({ rawLot, finalLot, riskUSD: budgetUSD, actualRiskUSD: actual, riskDeviationPercent: dev, forcedMinimumLot: forced });
}
