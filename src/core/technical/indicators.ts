// Real-market technical evidence (Vertical Slice v1). Pure, deterministic, CLOSED bars only.
// Implemented from the slice contract itself; it does NOT import src/probe (probe stays diagnostic).
// All outputs are EVIDENCE. None of these functions decide a trade.

export const TECHNICAL_ENGINE_VERSION = "tech-v2.0";

/** A CLOSED bar as consumed by the technical engine. Times are epoch ms on the bar's own time axis. */
export interface TechBar {
  readonly open_time: number;
  readonly close_time: number;
  /** When the bar became knowable to this system. Consumers at T may use it only if available_at <= T. */
  readonly available_at: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export type Insufficient = { readonly status: "INSUFFICIENT_HISTORY"; readonly required: number; readonly have: number };
export type Valued = { readonly status: "OK"; readonly value: number; readonly as_of_bar: number };
export type Indicator = Valued | Insufficient;

const insufficient = (required: number, have: number): Insufficient => ({ status: "INSUFFICIENT_HISTORY", required, have });

/** EMA(n), seeded with SMA of the first n closes, alpha = 2/(n+1). */
export function ema(bars: readonly TechBar[], n: number): Indicator {
  if (bars.length < n) return insufficient(n, bars.length);
  let v = 0;
  for (let i = 0; i < n; i++) v += bars[i]!.close;
  v /= n;
  const a = 2 / (n + 1);
  for (let i = n; i < bars.length; i++) v = a * bars[i]!.close + (1 - a) * v;
  return { status: "OK", value: v, as_of_bar: bars[bars.length - 1]!.open_time };
}

/** ATR(14) Wilder: TR seeded with SMA of first n TRs (TR[0] uses high-low), then (prev*(n-1)+TR)/n. Needs n+1 bars. */
export function atrWilder(bars: readonly TechBar[], n = 14): Indicator {
  if (bars.length < n + 1) return insufficient(n + 1, bars.length);
  const tr = (i: number) => {
    const b = bars[i]!, pc = bars[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  };
  let v = 0;
  for (let i = 1; i <= n; i++) v += tr(i);
  v /= n;
  for (let i = n + 1; i < bars.length; i++) v = (v * (n - 1) + tr(i)) / n;
  return { status: "OK", value: v, as_of_bar: bars[bars.length - 1]!.open_time };
}

/**
 * RSI(14) Wilder — DIAGNOSTIC / RESEARCH CONFIGURATION, not a strategy rule.
 * avgGain/avgLoss seeded with SMA of first n close-to-close changes, then Wilder smoothing.
 * RSI = 100 - 100/(1+avgGain/avgLoss); avgLoss = 0 → 100 (or 50 when avgGain is also 0). Needs n+1 bars.
 */
export const RSI_CONFIG = Object.freeze({ period: 14, method: "WILDER", authority: "EVIDENCE_ONLY", status: "DIAGNOSTIC_DEFAULT_RESEARCH_REQUIRED" });
export function rsiWilder(bars: readonly TechBar[], n = RSI_CONFIG.period): Indicator {
  if (bars.length < n + 1) return insufficient(n + 1, bars.length);
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = bars[i]!.close - bars[i - 1]!.close; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < bars.length; i++) {
    const d = bars[i]!.close - bars[i - 1]!.close;
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  const value = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  return { status: "OK", value, as_of_bar: bars[bars.length - 1]!.open_time };
}

export type Relation = "EMA5_ABOVE_EMA21" | "EMA5_BELOW_EMA21" | "EMA5_EQUAL_EMA21" | "INSUFFICIENT_HISTORY";
export function emaRelation(e5: Indicator, e21: Indicator): Relation {
  if (e5.status !== "OK" || e21.status !== "OK") return "INSUFFICIENT_HISTORY";
  return e5.value > e21.value ? "EMA5_ABOVE_EMA21" : e5.value < e21.value ? "EMA5_BELOW_EMA21" : "EMA5_EQUAL_EMA21";
}

// ---------------- causal swings (2 left strict + 2 right tie-first-owner) ----------------

export interface Swing {
  readonly kind: "HIGH" | "LOW";
  readonly price: number;
  readonly pivot_time: number;
  /** close_time of the 2nd right-hand bar: the earliest moment the pivot is mathematically confirmed. */
  readonly confirmed_at: number;
  /** available_at of the 2nd right-hand bar (when this system could know it). */
  readonly available_at: number;
  /** Bar is simultaneously a swing high and a swing low; both facts are preserved. */
  readonly outside_bar: boolean;
}

/** 2+2 pivots, tie-rule B: left neighbours strictly beyond the bar, right neighbours may equal (first bar of an equal run owns the pivot). Bar i is eligible only once bars i+1 and i+2 are CLOSED. No lookahead beyond the input. */
export function causalSwings(bars: readonly TechBar[]): Swing[] {
  const out: Swing[] = [];
  for (let i = 2; i + 2 < bars.length; i++) {
    const b = bars[i]!;
    const left = [bars[i - 2]!, bars[i - 1]!], right = [bars[i + 1]!, bars[i + 2]!];
    const isH = left.every((x) => b.high > x.high) && right.every((x) => b.high >= x.high);
    const isL = left.every((x) => b.low < x.low) && right.every((x) => b.low <= x.low);
    const conf = bars[i + 2]!;
    const both = isH && isL;
    if (isH) out.push({ kind: "HIGH", price: b.high, pivot_time: b.open_time, confirmed_at: conf.close_time, available_at: conf.available_at, outside_bar: both });
    if (isL) out.push({ kind: "LOW", price: b.low, pivot_time: b.open_time, confirmed_at: conf.close_time, available_at: conf.available_at, outside_bar: both });
  }
  return out;
}

export type HighLabel = "HH" | "LH" | "EQUAL_HIGH";
export type LowLabel = "HL" | "LL" | "EQUAL_LOW";
export interface LabelledSwing extends Swing { readonly label: HighLabel | LowLabel | "FIRST" }
export interface Structure {
  readonly swings: readonly LabelledSwing[];
  readonly latest_high: HighLabel | "FIRST" | null;
  readonly latest_low: LowLabel | "FIRST" | null;
  /** Factual summary of the two latest labels; not an interpretation. */
  readonly summary: "HH_HL" | "LH_LL" | "MIXED" | "INSUFFICIENT_HISTORY";
}

export function structureOf(bars: readonly TechBar[]): Structure {
  const swings = causalSwings(bars);
  let pH: number | null = null, pL: number | null = null;
  const labelled: LabelledSwing[] = swings.map((s) => {
    let label: LabelledSwing["label"];
    if (s.kind === "HIGH") { label = pH === null ? "FIRST" : s.price > pH ? "HH" : s.price < pH ? "LH" : "EQUAL_HIGH"; pH = s.price; }
    else { label = pL === null ? "FIRST" : s.price > pL ? "HL" : s.price < pL ? "LL" : "EQUAL_LOW"; pL = s.price; }
    return { ...s, label };
  });
  const lastH = [...labelled].reverse().find((s) => s.kind === "HIGH");
  const lastL = [...labelled].reverse().find((s) => s.kind === "LOW");
  const h = (lastH?.label ?? null) as Structure["latest_high"];
  const l = (lastL?.label ?? null) as Structure["latest_low"];
  const summary: Structure["summary"] = !h || !l || h === "FIRST" || l === "FIRST" ? "INSUFFICIENT_HISTORY"
    : h === "HH" && l === "HL" ? "HH_HL" : h === "LH" && l === "LL" ? "LH_LL" : "MIXED";
  return { swings: labelled, latest_high: h, latest_low: l, summary };
}

// ---------------- SNR facts ----------------

export interface NearestLevels {
  readonly reference_price: number;
  readonly nearest_support: Swing | null;
  readonly nearest_resistance: Swing | null;
  readonly distance_to_support: number | null;
  readonly distance_to_resistance: number | null;
  readonly distance_atr_support: number | null;
  readonly distance_atr_resistance: number | null;
  readonly interpretation: "RESEARCH_REQUIRED";
}

/** Support = confirmed swing LOW strictly below price; resistance = confirmed swing HIGH strictly above. No role flipping. */
export function nearestLevels(swings: readonly Swing[], price: number, atr: Indicator): NearestLevels {
  let s: Swing | null = null, r: Swing | null = null;
  for (const w of swings) {
    if (w.kind === "LOW" && w.price < price && (!s || w.price > s.price)) s = w;
    if (w.kind === "HIGH" && w.price > price && (!r || w.price < r.price)) r = w;
  }
  const ds = s ? price - s.price : null, dr = r ? r.price - price : null;
  const a = atr.status === "OK" && atr.value > 0 ? atr.value : null;
  return {
    reference_price: price, nearest_support: s, nearest_resistance: r, distance_to_support: ds, distance_to_resistance: dr,
    distance_atr_support: ds !== null && a ? ds / a : null, distance_atr_resistance: dr !== null && a ? dr / a : null,
    interpretation: "RESEARCH_REQUIRED",
  };
}

// ---------------- candle geometry / engulfing ----------------

export interface CandleGeometry {
  readonly bar: TechBar;
  readonly direction: "BULLISH" | "BEARISH" | "DOJI";
  readonly body: number;
  readonly range: number;
  readonly upper_wick: number;
  readonly lower_wick: number;
  /** null when range == 0 (no division by zero). */
  readonly body_to_range: number | null;
}
export function geometry(b: TechBar): CandleGeometry {
  const body = Math.abs(b.close - b.open), range = b.high - b.low;
  return {
    bar: b, direction: b.close > b.open ? "BULLISH" : b.close < b.open ? "BEARISH" : "DOJI",
    body, range, upper_wick: b.high - Math.max(b.open, b.close), lower_wick: Math.min(b.open, b.close) - b.low,
    body_to_range: range > 0 ? body / range : null,
  };
}

/**
 * Body engulfing on the last two CLOSED bars (prev, curr):
 * Bullish: prev.close < prev.open AND curr.close > curr.open AND curr.open <= prev.close AND curr.close >= prev.open
 *          AND (curr.close - curr.open) > (prev.open - prev.close).
 * Bearish: mirror. Wicks are ignored. No thresholds.
 */
export const ENGULFING_DEFINITION = "BODY_ENGULF_STRICT_LARGER_BODY_v1";
export function engulfing(prev: TechBar, curr: TechBar): { bullish: boolean; bearish: boolean } {
  const bullish = prev.close < prev.open && curr.close > curr.open && curr.open <= prev.close && curr.close >= prev.open
    && curr.close - curr.open > prev.open - prev.close;
  const bearish = prev.close > prev.open && curr.close < curr.open && curr.open >= prev.close && curr.close <= prev.open
    && curr.open - curr.close > prev.close - prev.open;
  return { bullish, bearish };
}

export const RESEARCH_REQUIRED_PATTERNS = Object.freeze(["BODY_EXPANSION"] as const); // others defined in operator.ts (candle-patterns-v1)

/** Bounded ring with percentiles (nearest-rank). Used for spread and latency telemetry. */
export class Telemetry {
  private buf: number[] = [];
  total = 0;
  constructor(private readonly cap: number) {}
  push(v: number) { if (!Number.isFinite(v)) return; this.buf.push(v); this.total++; if (this.buf.length > this.cap) this.buf.shift(); }
  get size() { return this.buf.length; }
  percentile(p: number): number | null {
    if (!this.buf.length) return null;
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
  }
  summary() { return { n: this.buf.length, total: this.total, p50: this.percentile(50), p90: this.percentile(90), p95: this.percentile(95), p99: this.percentile(99) }; }
}
