import { calculationLockGate } from "../../candle-manager/closedCandleManager";
import { deepFreeze } from "../../../execution/executionSnapshot";
import { trackFVGs } from "./fvgTracker";
import { detectOrderBlocks, displacementOf } from "./orderBlockDetector";
import { INSTITUTIONAL_RADAR_PARAMS as P, type FootprintDirection, type InstitutionalFootprints, type InstitutionalRadarInput } from "./types";

/** Passive evidence only. Never returns a direction to trade, SL/TP, lot or score. */
export function scanInstitutionalFootprints(input: InstitutionalRadarInput): InstitutionalFootprints {
  const { structure: s, atr14M15: atr } = input;
  const candles = input.candles
    .filter((c) => calculationLockGate(c).canCalculate && c.symbol === s.symbol)
    .slice().sort((a, b) => a.timestamp - b.timestamp);
  const last = candles.at(-1);

  let sweepDetected = false, sweepDirection: FootprintDirection | null = null, sweepWickDistance = 0, sweepAgeBars = -1;
  const lo = s.lastConfirmedLow, hi = s.lastConfirmedHigh;
  for (let age = 0; age <= P.SWEEP_TTL_BARS && age < candles.length; age++) {
    const c = candles[candles.length - 1 - age];
    if (lo && c.timestamp > lo.timestamp && c.low < lo.price && c.close > lo.price) {
      sweepDetected = true; sweepDirection = "BULLISH"; sweepWickDistance = lo.price - c.low; sweepAgeBars = age; break;
    }
    if (hi && c.timestamp > hi.timestamp && c.high > hi.price && c.close < hi.price) {
      sweepDetected = true; sweepDirection = "BEARISH"; sweepWickDistance = c.high - hi.price; sweepAgeBars = age; break;
    }
  }

  let displacementPreceded = false, displacementMagnitude = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (displacementOf(candles[i], s, atr)) {
      displacementPreceded = true; displacementMagnitude = Math.abs(candles[i].close - candles[i].open) / atr; break;
    }
  }

  const close = last?.close ?? NaN;
  const fvg = [...trackFVGs(candles)].reverse().find((z) => z.status !== "INVALIDATED" && close >= z.bottom && close <= z.top);
  const ob = [...detectOrderBlocks(candles, s, atr)].reverse().find((z) => z.status === "ACTIVE" && close >= z.low && close <= z.high);

  return deepFreeze({
    sweepDetected, sweepDirection, sweepWickDistance, sweepAgeBars,
    displacementPreceded, displacementMagnitude,
    insideFVG: !!fvg, activeFVGId: fvg?.id ?? null,
    insideOrderBlock: !!ob, activeOrderBlockId: ob?.id ?? null,
    timestamp: last?.timestamp ?? 0,
  });
}
