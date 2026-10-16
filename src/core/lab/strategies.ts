// Strategy Lab (PAPER EXPERIMENT ONLY). Five named, independent entry modes evaluated on CLOSED broker M5/M15 bars.
// Authority: EXPERIMENT. Never imports broker/gateway/execution; never feeds LivePaperLoop, Decision Gate, Risk or demo bridge.
import { atrWilder, causalSwings, ema, engulfing, geometry, type TechBar } from "@/core/technical/indicators";

export const STRATEGY_LAB_VERSION = "strategy-lab-v1";
export const LAB_STRATEGIES = ["TOUCH_SNR", "EMA_CROSS", "SNR_PA", "DUAL_WALL", "FAST_BREAKOUT"] as const;
export type LabStrategy = (typeof LAB_STRATEGIES)[number];
export type LabSide = "BUY" | "SELL";

export const LAB_LABELS: Record<LabStrategy, string> = {
  TOUCH_SNR: "Sentuh S/R",
  EMA_CROSS: "EMA 9/21 Cross",
  SNR_PA: "S/R + Candle (Hammer/Star/Engulf)",
  DUAL_WALL: "S/R + EMA 21/50",
  FAST_BREAKOUT: "Breakout 5 bar",
};

/** Every experiment parameter lives here; changing one means bumping STRATEGY_LAB_VERSION. */
export const LAB_PARAMS = Object.freeze({
  ZONE_HALF_WIDTH_ATR_M15: 0.25,
  ZONE_LOOKBACK_SWINGS: 8,
  SL_ATR_M5: 1.0,
  ZONE_SL_BUFFER_ATR_M5: 0.2,
  TP_R: 1.5,
  EMA_WALL_ATR_M5: 0.3,
  BREAKOUT_LOOKBACK: 5,
  BREAKOUT_BODY_MIN: 0.6,
  HAMMER_WICK_BODY: 2,
  HAMMER_WICK_RANGE: 0.5,
});

export interface LabSignal {
  readonly strategy: LabStrategy;
  readonly side: LabSide;
  readonly why: string;
  /** Distance from fill to SL, price units (>0). TP distance = sl_distance × TP_R. */
  readonly sl_distance: number;
  readonly bar_time: number;
}

interface Zone { readonly kind: "SUPPORT" | "RESISTANCE"; readonly low: number; readonly high: number; readonly price: number }

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(3));

function zonesOf(m15: readonly TechBar[], asOf: number, atr15: number): Zone[] {
  const w = atr15 * LAB_PARAMS.ZONE_HALF_WIDTH_ATR_M15;
  return causalSwings(m15).filter((s) => s.available_at <= asOf).slice(-LAB_PARAMS.ZONE_LOOKBACK_SWINGS)
    .map((s) => ({ kind: s.kind === "LOW" ? "SUPPORT" : "RESISTANCE", low: s.price - w, high: s.price + w, price: s.price }));
}

/** Pure: evaluate all five modes on the latest CLOSED M5 bar. Returns zero or more independent signals. */
export function evaluateLab(m5: readonly TechBar[], m15: readonly TechBar[]): LabSignal[] {
  if (m5.length < 60 || m15.length < 20) return [];
  const bar = m5[m5.length - 1]!, prev = m5[m5.length - 2]!;
  const a5 = atrWilder(m5), a15 = atrWilder(m15);
  if (a5.status !== "OK" || a15.status !== "OK") return [];
  const atr = a5.value;
  const zones = zonesOf(m15, bar.close_time, a15.value);
  const out: LabSignal[] = [];
  const push = (strategy: LabStrategy, side: LabSide, why: string, sl: number) => out.push({ strategy, side, why, sl_distance: sl, bar_time: bar.open_time });
  const baseSl = atr * LAB_PARAMS.SL_ATR_M5;

  const sup = zones.filter((z) => z.kind === "SUPPORT" && bar.low <= z.high && bar.close >= z.low);
  const res = zones.filter((z) => z.kind === "RESISTANCE" && bar.high >= z.low && bar.close <= z.high);
  const zoneSl = (side: LabSide, z: Zone) => Math.max(baseSl * 0.5, side === "BUY" ? bar.close - (z.low - atr * LAB_PARAMS.ZONE_SL_BUFFER_ATR_M5) : (z.high + atr * LAB_PARAMS.ZONE_SL_BUFFER_ATR_M5) - bar.close);

  // 1. TOUCH_SNR — touch of an M15 zone on the closed M5 bar.
  if (sup[0]) push("TOUCH_SNR", "BUY", `Sentuh support M15 ${fmt(sup[0].price)}`, zoneSl("BUY", sup[0]));
  if (res[0]) push("TOUCH_SNR", "SELL", `Sentuh resisten M15 ${fmt(res[0].price)}`, zoneSl("SELL", res[0]));

  // 2. EMA_CROSS — EMA9 crosses EMA21 on M5.
  const e9 = ema(m5, 9), e21 = ema(m5, 21), p9 = ema(m5.slice(0, -1), 9), p21 = ema(m5.slice(0, -1), 21), e50 = ema(m5, 50);
  if (e9.status === "OK" && e21.status === "OK" && p9.status === "OK" && p21.status === "OK") {
    if (p9.value <= p21.value && e9.value > e21.value) push("EMA_CROSS", "BUY", "Golden cross EMA9 > EMA21 M5", baseSl);
    if (p9.value >= p21.value && e9.value < e21.value) push("EMA_CROSS", "SELL", "Death cross EMA9 < EMA21 M5", baseSl);
  }

  // 3. SNR_PA — zone + rejection candle.
  const g = geometry(bar), eg = engulfing(prev, bar);
  const hammer = g.body > 0 ? g.lower_wick >= LAB_PARAMS.HAMMER_WICK_BODY * g.body && g.lower_wick >= LAB_PARAMS.HAMMER_WICK_RANGE * g.range : g.range > 0 && g.lower_wick >= LAB_PARAMS.HAMMER_WICK_RANGE * g.range;
  const star = g.body > 0 ? g.upper_wick >= LAB_PARAMS.HAMMER_WICK_BODY * g.body && g.upper_wick >= LAB_PARAMS.HAMMER_WICK_RANGE * g.range : g.range > 0 && g.upper_wick >= LAB_PARAMS.HAMMER_WICK_RANGE * g.range;
  if (sup[0] && (hammer || eg.bullish)) push("SNR_PA", "BUY", `${eg.bullish ? "Bullish engulfing" : "Hammer"} di support ${fmt(sup[0].price)}`, zoneSl("BUY", sup[0]));
  if (res[0] && (star || eg.bearish)) push("SNR_PA", "SELL", `${eg.bearish ? "Bearish engulfing" : "Shooting star"} di resisten ${fmt(res[0].price)}`, zoneSl("SELL", res[0]));

  // 4. DUAL_WALL — zone + EMA21/50 confluence, candle closes in the bounce direction.
  if (e21.status === "OK" && e50.status === "OK") {
    const near = (lvl: number) => Math.abs(bar.close - lvl) <= atr * LAB_PARAMS.EMA_WALL_ATR_M5 || (bar.low <= lvl && bar.high >= lvl);
    const wall = near(e21.value) ? "EMA21" : near(e50.value) ? "EMA50" : null;
    if (wall && sup[0] && g.direction === "BULLISH") push("DUAL_WALL", "BUY", `Support ${fmt(sup[0].price)} + ${wall}`, zoneSl("BUY", sup[0]));
    if (wall && res[0] && g.direction === "BEARISH") push("DUAL_WALL", "SELL", `Resisten ${fmt(res[0].price)} + ${wall}`, zoneSl("SELL", res[0]));
  }

  // 5. FAST_BREAKOUT — strong close beyond the previous N bars' extreme.
  const lb = m5.slice(-1 - LAB_PARAMS.BREAKOUT_LOOKBACK, -1);
  const hi = Math.max(...lb.map((b) => b.high)), lo = Math.min(...lb.map((b) => b.low));
  const strong = (g.body_to_range ?? 0) >= LAB_PARAMS.BREAKOUT_BODY_MIN;
  if (strong && bar.close > hi && g.direction === "BULLISH") push("FAST_BREAKOUT", "BUY", `Tembus high ${LAB_PARAMS.BREAKOUT_LOOKBACK} bar ${fmt(hi)}`, baseSl);
  if (strong && bar.close < lo && g.direction === "BEARISH") push("FAST_BREAKOUT", "SELL", `Tembus low ${LAB_PARAMS.BREAKOUT_LOOKBACK} bar ${fmt(lo)}`, baseSl);

  return out.filter((s) => s.sl_distance > 0 && Number.isFinite(s.sl_distance));
}
