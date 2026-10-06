import type { ArenaCandle } from "../normalizer/types";
import { computeAtr } from "../location/priceLocationEngine";
import { calculateEMA, classifySlope } from "./emaCalculator";
import {
  EMA_PARAMS as P,
  type EMAAction,
  type EMAContextResult,
  type EMAPricePosition,
} from "./types";

const touches = (c: ArenaCandle, ema: number) => c.low <= ema && ema <= c.high;

export function classifyPricePosition(close: number, e5: number, e21: number, e50: number): EMAPricePosition {
  if (close > e5 && close > e21 && close > e50) return "ABOVE_ALL";
  if (close < e5 && close < e21 && close < e50) return "BELOW_ALL";
  if (close > Math.min(e21, e50) && close < Math.max(e21, e50)) return "BETWEEN_EMA21_EMA50";
  return "INSIDE_EMA_ZONE";
}

export function computeEMAContext(candles: readonly ArenaCandle[], now: number): EMAContextResult {
  const closed = candles.filter((c) => c.isClosed);
  const last = closed[closed.length - 1];
  if (!last) return { ok: false, reason: "INSUFFICIENT_HISTORY" };
  if (last.timeframe !== "M5" && last.timeframe !== "M15") return { ok: false, reason: "INVALID_TIMEFRAME" };
  if (closed.some((c) => c.timeframe !== last.timeframe || c.symbol !== last.symbol)) return { ok: false, reason: "INVALID_TIMEFRAME" };

  const s5 = calculateEMA(closed, 5), s21 = calculateEMA(closed, 21), s50 = calculateEMA(closed, 50);
  if (s5 === "INSUFFICIENT_HISTORY" || s21 === "INSUFFICIENT_HISTORY" || s50 === "INSUFFICIENT_HISTORY")
    return { ok: false, reason: "INSUFFICIENT_HISTORY" };
  const atr = computeAtr(closed, P.ATR_PERIOD);
  if (atr === null || atr <= 0) return { ok: false, reason: "INSUFFICIENT_ATR_HISTORY" };

  const n = closed.length - 1;
  const e5 = s5[n]!, e21 = s21[n]!, e50 = s50[n]!;
  const prev = closed[n - 1]!;
  const close = last.close;
  const actions: EMAAction[] = [];

  if (e5 > e21) actions.push("EMA5_ABOVE_EMA21");
  else if (e5 < e21) actions.push("EMA5_BELOW_EMA21");

  // EMA21 retest
  const near = (i: number) => Math.abs(closed[i]!.close - s21[i]!) <= atr * P.RETEST_ATR_MULT;
  let awayBefore = true;
  for (let j = 1; j <= P.RETEST_AWAY_BARS; j++) if (near(n - j)) awayBefore = false;
  if (near(n) && awayBefore) actions.push("EMA21_RETEST");

  const away = atr * P.REJECT_AWAY_ATR_MULT;
  const bull = last.close > last.open, bear = last.close < last.open;
  if (touches(prev, s21[n - 1]!)) {
    if (bull && close >= e21 + away) actions.push("EMA21_REJECT_UP");
    if (bear && close <= e21 - away) actions.push("EMA21_REJECT_DOWN");
  }
  if (touches(prev, s50[n - 1]!)) {
    if (bull && close >= e50 + away) actions.push("EMA50_SUPPORT");
    if (bear && close <= e50 - away) actions.push("EMA50_RESISTANCE");
  }

  const g = P.GAP_LOOKBACK;
  const gapA = (i: number) => Math.abs(s5[i]! - s21[i]!);
  const gapB = (i: number) => Math.abs(s21[i]! - s50[i]!);
  const compression = gapA(n) < gapA(n - g) && gapB(n) < gapB(n - g);
  const expansion = gapA(n) > gapA(n - g) && gapB(n) > gapB(n - g);
  if (compression) actions.push("EMA_COMPRESSION");
  if (expansion) actions.push("EMA_EXPANSION");
  if (actions.length === 0) actions.push("NONE");

  const tf = last.timeframe;
  return {
    ok: true,
    context: {
      symbol: last.symbol,
      timeframe: tf,
      values: { symbol: last.symbol, timeframe: tf, timestamp: last.timestamp, ema5: e5, ema21: e21, ema50: e50 },
      slope21: classifySlope(s21, atr),
      slope50: classifySlope(s50, atr),
      pricePosition: classifyPricePosition(close, e5, e21, e50),
      actions,
      distanceToEMA21: Math.abs(close - e21),
      distanceToEMA50: Math.abs(close - e50),
      compression,
      expansion,
      updatedAt: now,
    },
  };
}
