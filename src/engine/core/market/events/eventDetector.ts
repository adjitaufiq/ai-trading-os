// M1B.11 — raw detections from passive inputs. Facts only; no interpretation, no direction to trade.
import type { EventObservation, MarketEventType } from "./types";

export interface Detection {
  type: MarketEventType;
  timeframe: string | null;
  subject: string;
  evidence: string[];
}

export interface PreviousContext {
  regime: string | null;
  horizon: string | null;
  volatility: string | null;
}

export function detectEvents(o: EventObservation, prev: PreviousContext): Detection[] {
  const out: Detection[] = [];
  const regimeOk = o.regime.asOf <= o.barTime && o.regime.symbol === o.symbol;
  const horizonOk = o.horizon.asOf <= o.barTime && o.horizon.symbol === o.symbol;
  const fp = o.footprints && o.footprints.timestamp <= o.barTime ? o.footprints : null;

  if (fp?.sweepDetected) {
    out.push({ type: "LIQUIDITY_SWEEP", timeframe: o.footprintTimeframe ?? "M15", subject: "sweep",
      evidence: ["M1B8_SWEEP_DETECTED", `SWEEP_SIDE_${fp.sweepDirection ?? "UNKNOWN"}`, `SWEEP_AGE_${fp.sweepAgeBars}`] });
  }
  if (regimeOk && prev.regime !== null && prev.regime !== o.regime.regime) {
    out.push({ type: "REGIME_CHANGE", timeframe: null, subject: "regime", evidence: [`REGIME_${prev.regime}_TO_${o.regime.regime}`] });
  }
  if (horizonOk && prev.horizon !== null && prev.horizon !== o.horizon.recommendedHorizon) {
    out.push({ type: "HORIZON_CHANGE", timeframe: null, subject: "horizon", evidence: [`HORIZON_${prev.horizon}_TO_${o.horizon.recommendedHorizon}`] });
  }
  if (regimeOk && o.regime.volatility === "EXPANSION" && prev.volatility !== "EXPANSION") {
    // M1B.9 volatility is derived from injected M15 ATR ⇒ timeframe M15 (not invented).
    out.push({ type: "VOLATILITY_EXPANSION", timeframe: "M15", subject: "atr",
      evidence: ["M1B9_VOLATILITY_EXPANSION", `ATR_PERCENTILE_${o.regime.rangeContext.atrPercentile}`] });
  }
  for (const s of o.snrInteractions ?? []) {
    out.push({ type: "SNR_INTERACTION", timeframe: s.timeframe, subject: s.levelId, evidence: [`SNR_TOUCH_${s.side}`, `LEVEL_${s.levelId}`] });
  }
  return out;
}
