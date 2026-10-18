// Strategy Lab (PAPER EXPERIMENT ONLY). Five named, independent entry modes evaluated on CLOSED broker M5/M15 bars.
// Authority: EXPERIMENT. Never imports broker/gateway/execution; never feeds LivePaperLoop, Decision Gate, Risk or demo bridge.
import { atrWilder, causalSwings, ema, engulfing, geometry, type TechBar } from "@/core/technical/indicators";

export const STRATEGY_LAB_VERSION = "strategy-lab-v4-touch-h1-compass";
export const LAB_STRATEGIES = ["TOUCH_SNR", "EMA_CROSS", "SNR_PA", "DUAL_WALL", "FAST_BREAKOUT",
  "TREND_PULLBACK", "SWEEP_RECLAIM", "BREAKOUT_RETEST", "RANGE_REVERSAL", "ATR_EXPANSION", "DUAL_WALL_FAST"] as const;
/** Modes 6–10 (hypotheses, paper only). */
export const LAB_NEW_STRATEGIES = ["TREND_PULLBACK", "SWEEP_RECLAIM", "BREAKOUT_RETEST", "RANGE_REVERSAL", "ATR_EXPANSION"] as const;
export type LabStrategy = (typeof LAB_STRATEGIES)[number];
export type LabSide = "BUY" | "SELL";

export const LAB_LABELS: Record<LabStrategy, string> = {
  TOUCH_SNR: "1 · Sentuh S/R + EMA 9/21",
  EMA_CROSS: "2 · EMA 9/21 Cross",
  SNR_PA: "3 · S/R + Candle (Hammer/Star/Engulf)",
  DUAL_WALL: "4 · S/R + EMA 21/50",
  FAST_BREAKOUT: "5 · Breakout 5 bar",
  TREND_PULLBACK: "6 · Trend Pullback + Struktur",
  SWEEP_RECLAIM: "7 · SNR Sweep & Reclaim",
  BREAKOUT_RETEST: "8 · Breakout M15 – Retest",
  RANGE_REVERSAL: "9 · Range Boundary Reversal",
  ATR_EXPANSION: "10 · ATR Expansion Breakout",
  DUAL_WALL_FAST: "11 · S/R + EMA 5/21",
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
  // Mode 6 TREND_PULLBACK
  TP_H1_MIN_BARS: 55,
  TP_PULLBACK_ATR_M15: 0.5,
  TP_MICRO_BREAK_BARS: 3,
  TP_SWING_BARS: 4,
  // Mode 7 SWEEP_RECLAIM
  SWEEP_WICK_RANGE: 0.5,
  // Mode 8 BREAKOUT_RETEST
  BRT_BREAK_WITHIN_M15: 8,
  BRT_RETEST_ATR_M5: 0.2,
  // Mode 9 RANGE_REVERSAL
  RANGE_H1_BARS: 24,
  RANGE_EMA_GAP_ATR_H1: 0.5,
  RANGE_MIN_WIDTH_ATR_H1: 2,
  RANGE_EDGE_FRACTION: 0.2,
  RANGE_SL_ATR_M15: 0.25,
  // Mode 10 ATR_EXPANSION
  EXP_RANGE_ATR_M5: 1.5,
  EXP_BODY_MIN: 0.6,
  EXP_OPP_WICK_MAX: 0.2,
  EXP_LOOKBACK: 10,
  // Mode 1 TOUCH_SNR compass: |EMA9−EMA21| (H1) ≤ this × ATR14(H1) ⇒ RANGE (both sides allowed)
  TOUCH_H1_RANGE_GAP_ATR: 0.25,
});

/** Explicit rule text for modes 6–10 (BUY shown; SELL is the mirror). */
export const LAB_RULES: Partial<Record<LabStrategy, string>> = Object.freeze({
  TREND_PULLBACK: "H1 EMA21>EMA50 (≥55 closed H1) ⇒ BUY side. Location: closed M5 low within 0.5×ATR14(M15) of M15 EMA21/EMA50 or an M15 support zone. Trigger: closed M5 bullish AND close > highest high of previous 3 M5 bars. Invalid: close < M15 EMA50 − 0.5×ATR(M15). SL below lowest low of last 4 M5 bars − 0.2×ATR(M5).",
  SWEEP_RECLAIM: "Closed M5 low < M15 support zone low AND close ≥ zone low AND bullish AND lower wick ≥ 0.5×range. Invalid: close still below zone. SL = sweep low − 0.2×ATR(M5).",
  BREAKOUT_RETEST: "Latest available M15 swing HIGH broken by a closed M15 close above it within the last 8 M15 bars (after the swing became available). Trigger: closed M5 low ≤ level + 0.2×ATR(M5), close > level, bullish. Invalid: close ≤ level. SL = level − 0.2×ATR(M5).",
  RANGE_REVERSAL: "H1 range: |EMA21−EMA50| ≤ 0.5×ATR14(H1) and last 24 H1 high−low ≥ 2×ATR(H1). BUY only when close is in the bottom 20% of the range AND hammer or bullish engulfing. Middle 20–80% ⇒ reject. SL = range low − 0.25×ATR(M15).",
  DUAL_WALL_FAST: "Same as DUAL_WALL with EMA5/EMA21 (M5): closed M5 touches M15 support + close within 0.3×ATR(M5) of EMA5 or EMA21 (or bar spans it) + bullish ⇒ BUY; SELL mirror at resistance. SL = zone edge ± 0.2×ATR(M5).",
  ATR_EXPANSION: "Closed M5 range ≥ 1.5×ATR14(M5), body ≥ 0.6×range, upper wick ≤ 0.2×range, bullish, close > highest high of previous 10 M5 bars. SL = 1×ATR(M5).",
});

export interface LabReject { readonly strategy: LabStrategy; readonly reason: string }

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
export function evaluateLab(m5: readonly TechBar[], m15: readonly TechBar[], h1: readonly TechBar[] = []): LabSignal[] {
  return evaluateLabDetailed(m5, m15, h1).signals;
}

/** Same evaluation plus an explicit reject reason for every mode 6–10 that did not fire on this bar. */
export function evaluateLabDetailed(m5: readonly TechBar[], m15: readonly TechBar[], h1: readonly TechBar[] = []): { signals: LabSignal[]; rejects: LabReject[] } {
  const rejects: LabReject[] = [];
  if (m5.length < 60 || m15.length < 20) return { signals: [], rejects: LAB_NEW_STRATEGIES.map((strategy) => ({ strategy, reason: "INSUFFICIENT_M5_M15_HISTORY" })) };
  const bar = m5[m5.length - 1]!, prev = m5[m5.length - 2]!;
  const a5 = atrWilder(m5), a15 = atrWilder(m15);
  if (a5.status !== "OK" || a15.status !== "OK") return { signals: [], rejects: LAB_NEW_STRATEGIES.map((strategy) => ({ strategy, reason: "ATR_UNAVAILABLE" })) };
  const atr = a5.value;
  const zones = zonesOf(m15, bar.close_time, a15.value);
  const out: LabSignal[] = [];
  const push = (strategy: LabStrategy, side: LabSide, why: string, sl: number) => out.push({ strategy, side, why, sl_distance: sl, bar_time: bar.open_time });
  const baseSl = atr * LAB_PARAMS.SL_ATR_M5;

  const sup = zones.filter((z) => z.kind === "SUPPORT" && bar.low <= z.high && bar.close >= z.low);
  const res = zones.filter((z) => z.kind === "RESISTANCE" && bar.high >= z.low && bar.close <= z.high);
  const zoneSl = (side: LabSide, z: Zone) => Math.max(baseSl * 0.5, side === "BUY" ? bar.close - (z.low - atr * LAB_PARAMS.ZONE_SL_BUFFER_ATR_M5) : (z.high + atr * LAB_PARAMS.ZONE_SL_BUFFER_ATR_M5) - bar.close);

  // 1. TOUCH_SNR — touch of an M15 zone on the closed M5 bar, filtered by H1 EMA9/21 compass + M5 candle direction.
  {
    const c1 = m5.length ? geometry(bar) : null;
    const h1x = h1.filter((b) => b.close_time <= bar.close_time);
    const h9 = ema(h1x, 9), h21 = ema(h1x, 21), ah1 = atrWilder(h1x);
    let compass: "UP" | "DOWN" | "RANGE" | "UNKNOWN" = "UNKNOWN";
    if (h9.status === "OK" && h21.status === "OK" && ah1.status === "OK") {
      const gap = h9.value - h21.value;
      compass = Math.abs(gap) <= ah1.value * LAB_PARAMS.TOUCH_H1_RANGE_GAP_ATR ? "RANGE" : gap > 0 ? "UP" : "DOWN";
    }
    const buyCandle = !!c1 && (c1.direction === "BULLISH" || (c1.range > 0 && c1.lower_wick >= c1.body && c1.lower_wick > 0));
    const sellCandle = !!c1 && (c1.direction === "BEARISH" || (c1.range > 0 && c1.upper_wick >= c1.body && c1.upper_wick > 0));
    const tag = compass === "UNKNOWN" ? "H1 n/a" : `H1 ${compass}`;
    if (sup[0] && compass !== "DOWN" && buyCandle) push("TOUCH_SNR", "BUY", `Sentuh support M15 ${fmt(sup[0].price)} · ${tag} · candle M5 searah`, zoneSl("BUY", sup[0]));
    if (res[0] && compass !== "UP" && sellCandle) push("TOUCH_SNR", "SELL", `Sentuh resisten M15 ${fmt(res[0].price)} · ${tag} · candle M5 searah`, zoneSl("SELL", res[0]));
  }

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

  // 11. DUAL_WALL_FAST — identical to DUAL_WALL with EMA5/EMA21.
  const e5 = ema(m5, 5);
  if (e5.status === "OK" && e21.status === "OK") {
    const near = (lvl: number) => Math.abs(bar.close - lvl) <= atr * LAB_PARAMS.EMA_WALL_ATR_M5 || (bar.low <= lvl && bar.high >= lvl);
    const wall = near(e5.value) ? "EMA5" : near(e21.value) ? "EMA21" : null;
    if (wall && sup[0] && g.direction === "BULLISH") push("DUAL_WALL_FAST", "BUY", `Support ${fmt(sup[0].price)} + ${wall}`, zoneSl("BUY", sup[0]));
    if (wall && res[0] && g.direction === "BEARISH") push("DUAL_WALL_FAST", "SELL", `Resisten ${fmt(res[0].price)} + ${wall}`, zoneSl("SELL", res[0]));
  }

  // 5. FAST_BREAKOUT — strong close beyond the previous N bars' extreme.
  const lb = m5.slice(-1 - LAB_PARAMS.BREAKOUT_LOOKBACK, -1);
  const hi = Math.max(...lb.map((b) => b.high)), lo = Math.min(...lb.map((b) => b.low));
  const strong = (g.body_to_range ?? 0) >= LAB_PARAMS.BREAKOUT_BODY_MIN;
  if (strong && bar.close > hi && g.direction === "BULLISH") push("FAST_BREAKOUT", "BUY", `Tembus high ${LAB_PARAMS.BREAKOUT_LOOKBACK} bar ${fmt(hi)}`, baseSl);
  if (strong && bar.close < lo && g.direction === "BEARISH") push("FAST_BREAKOUT", "SELL", `Tembus low ${LAB_PARAMS.BREAKOUT_LOOKBACK} bar ${fmt(lo)}`, baseSl);

  const rej = (strategy: LabStrategy, reason: string) => rejects.push({ strategy, reason });
  const prevBars = (n: number) => m5.slice(-1 - n, -1);
  const bull = g.direction === "BULLISH", bear = g.direction === "BEARISH";
  const atr15 = a15.value;
  // H1 context: only bars CLOSED by the evaluated M5 bar's close (no look-ahead).
  const h1c = h1.filter((b) => b.close_time <= bar.close_time);

  // 6. TREND_PULLBACK — H1 EMA side, M15 pullback location, M5 micro-structure break.
  {
    const S: LabStrategy = "TREND_PULLBACK";
    const h21 = ema(h1c, 21), h50 = ema(h1c, 50), m21 = ema(m15, 21), m50 = ema(m15, 50);
    if (h1c.length < LAB_PARAMS.TP_H1_MIN_BARS || h21.status !== "OK" || h50.status !== "OK") rej(S, "H1_HISTORY_INSUFFICIENT");
    else if (m21.status !== "OK" || m50.status !== "OK") rej(S, "M15_EMA_UNAVAILABLE");
    else if (h21.value === h50.value) rej(S, "H1_NO_TREND");
    else {
      const up = h21.value > h50.value, tol = atr15 * LAB_PARAMS.TP_PULLBACK_ATR_M15;
      const edge = up ? bar.low : bar.high;
      const atEma = Math.abs(edge - m21.value) <= tol || Math.abs(edge - m50.value) <= tol;
      const atZone = (up ? zones.filter((z) => z.kind === "SUPPORT") : zones.filter((z) => z.kind === "RESISTANCE")).some((z) => edge >= z.low - tol && edge <= z.high + tol);
      const pb = prevBars(LAB_PARAMS.TP_MICRO_BREAK_BARS), win = m5.slice(-LAB_PARAMS.TP_SWING_BARS);
      if (up ? bar.close < m50.value - tol : bar.close > m50.value + tol) rej(S, "INVALID_PULLBACK_TOO_DEEP");
      else if (!atEma && !atZone) rej(S, "NOT_AT_PULLBACK_LOCATION");
      else if (up && !(bull && bar.close > Math.max(...pb.map((b) => b.high)))) rej(S, "NO_M5_STRUCTURE_BREAK");
      else if (!up && !(bear && bar.close < Math.min(...pb.map((b) => b.low)))) rej(S, "NO_M5_STRUCTURE_BREAK");
      else if (up) push(S, "BUY", `H1 naik, pullback ${atZone ? "support M15" : "EMA M15"}, M5 tembus high 3 bar`, bar.close - (Math.min(...win.map((b) => b.low)) - atr * LAB_PARAMS.ZONE_SL_BUFFER_ATR_M5));
      else push(S, "SELL", `H1 turun, pullback ${atZone ? "resisten M15" : "EMA M15"}, M5 tembus low 3 bar`, (Math.max(...win.map((b) => b.high)) + atr * LAB_PARAMS.ZONE_SL_BUFFER_ATR_M5) - bar.close);
    }
  }

  // 7. SWEEP_RECLAIM — wick sweeps beyond a zone, close reclaims inside it.
  {
    const S: LabStrategy = "SWEEP_RECLAIM", buf = atr * LAB_PARAMS.ZONE_SL_BUFFER_ATR_M5, wickMin = LAB_PARAMS.SWEEP_WICK_RANGE * g.range;
    const sw = zones.find((z) => z.kind === "SUPPORT" && bar.low < z.low && bar.close >= z.low);
    const sr = zones.find((z) => z.kind === "RESISTANCE" && bar.high > z.high && bar.close <= z.high);
    if (sw && bull && g.lower_wick >= wickMin) push(S, "BUY", `Sweep di bawah support ${fmt(sw.price)}, close reclaim`, bar.close - (bar.low - buf));
    else if (sr && bear && g.upper_wick >= wickMin) push(S, "SELL", `Sweep di atas resisten ${fmt(sr.price)}, close reclaim`, (bar.high + buf) - bar.close);
    else rej(S, sw || sr ? "RECLAIM_NOT_CONFIRMED" : "NO_ZONE_SWEEP");
  }

  // 8. BREAKOUT_RETEST — M15 swing broken by a closed M15 bar, closed M5 retest bounces off the level.
  {
    const S: LabStrategy = "BREAKOUT_RETEST", tol = atr * LAB_PARAMS.BRT_RETEST_ATR_M5;
    const sws = causalSwings(m15).filter((x) => x.available_at <= bar.close_time);
    const recent = m15.filter((b) => b.close_time <= bar.close_time).slice(-LAB_PARAMS.BRT_BREAK_WITHIN_M15);
    const broken = (k: "HIGH" | "LOW") => {
      const s = [...sws].reverse().find((x) => x.kind === k);
      if (!s) return null;
      const hit = recent.some((b) => b.open_time >= s.available_at && (k === "HIGH" ? b.close > s.price : b.close < s.price));
      return hit ? s.price : null;
    };
    const up = broken("HIGH"), dn = broken("LOW");
    if (up !== null && bar.low <= up + tol && bar.close > up && bull) push(S, "BUY", `Retest breakout M15 ${fmt(up)}`, bar.close - (up - tol));
    else if (dn !== null && bar.high >= dn - tol && bar.close < dn && bear) push(S, "SELL", `Retest breakdown M15 ${fmt(dn)}`, (dn + tol) - bar.close);
    else rej(S, up === null && dn === null ? "NO_RECENT_M15_BREAKOUT" : "NO_RETEST_TRIGGER");
  }

  // 9. RANGE_REVERSAL — only in a defined H1 range, only at its edges.
  {
    const S: LabStrategy = "RANGE_REVERSAL";
    const h21 = ema(h1c, 21), h50 = ema(h1c, 50), ah = atrWilder(h1c);
    const win = h1c.slice(-LAB_PARAMS.RANGE_H1_BARS);
    if (h21.status !== "OK" || h50.status !== "OK" || ah.status !== "OK" || win.length < LAB_PARAMS.RANGE_H1_BARS) rej(S, "H1_HISTORY_INSUFFICIENT");
    else {
      const hi = Math.max(...win.map((b) => b.high)), lo = Math.min(...win.map((b) => b.low)), width = hi - lo;
      if (Math.abs(h21.value - h50.value) > ah.value * LAB_PARAMS.RANGE_EMA_GAP_ATR_H1) rej(S, "NOT_RANGE_TRENDING");
      else if (width < ah.value * LAB_PARAMS.RANGE_MIN_WIDTH_ATR_H1) rej(S, "RANGE_TOO_NARROW");
      else {
        const pos = (bar.close - lo) / width, e = LAB_PARAMS.RANGE_EDGE_FRACTION, slb = atr15 * LAB_PARAMS.RANGE_SL_ATR_M15;
        if (pos > e && pos < 1 - e) rej(S, "MID_RANGE");
        else if (pos <= e && (hammer || eg.bullish)) push(S, "BUY", `Tepi bawah range H1 ${fmt(lo)}–${fmt(hi)} + ${eg.bullish ? "engulfing" : "hammer"}`, bar.close - (lo - slb));
        else if (pos >= 1 - e && (star || eg.bearish)) push(S, "SELL", `Tepi atas range H1 ${fmt(lo)}–${fmt(hi)} + ${eg.bearish ? "engulfing" : "shooting star"}`, (hi + slb) - bar.close);
        else rej(S, "NO_REVERSAL_CANDLE");
      }
    }
  }

  // 10. ATR_EXPANSION — expansion bar relative to ATR closing beyond the 10-bar extreme.
  {
    const S: LabStrategy = "ATR_EXPANSION", pb = prevBars(LAB_PARAMS.EXP_LOOKBACK);
    const hi10 = Math.max(...pb.map((b) => b.high)), lo10 = Math.min(...pb.map((b) => b.low));
    const big = g.range >= atr * LAB_PARAMS.EXP_RANGE_ATR_M5 && (g.body_to_range ?? 0) >= LAB_PARAMS.EXP_BODY_MIN;
    if (!big) rej(S, "NO_ATR_EXPANSION");
    else if (bull && g.upper_wick <= LAB_PARAMS.EXP_OPP_WICK_MAX * g.range && bar.close > hi10) push(S, "BUY", `Ekspansi ${(g.range / atr).toFixed(1)}×ATR tembus high 10 bar`, baseSl);
    else if (bear && g.lower_wick <= LAB_PARAMS.EXP_OPP_WICK_MAX * g.range && bar.close < lo10) push(S, "SELL", `Ekspansi ${(g.range / atr).toFixed(1)}×ATR tembus low 10 bar`, baseSl);
    else rej(S, "EXPANSION_NOT_BEYOND_RANGE");
  }

  return { signals: out.filter((s) => s.sl_distance > 0 && Number.isFinite(s.sl_distance)), rejects };
}
