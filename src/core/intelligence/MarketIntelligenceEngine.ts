// Market Intelligence Engine (mtf-intel-v1). Separate, pure evaluation layer composed by RadarRuntimeService.
// Hierarchy: H4 regime → H1 structural confirmation → M15 setup location → M5 timing → quality filter.
// Authority NONE / MONITOR_ONLY: descriptive output only. Never imports signal/plan/risk/execution; its
// "READY" status is context readiness, NOT a trade signal and never opens anything.
import type { MarketStructure } from "../../engine/core/swing/types";

export const MARKET_INTELLIGENCE_VERSION = "mtf-intel-v2" as const;

export type DecisionStatus = "READY" | "WAIT_CONFIRMATION" | "STAND_ASIDE" | "NO_DATA";
export type IntelBias = "BULLISH" | "BEARISH" | "SIDEWAYS" | "TRANSITION";
export type MarketPhase = "TRENDING" | "ACCUMULATION" | "DISTRIBUTION" | "RANGE" | "TRANSITION";
export type H1State = "FOLLOW_TREND" | "HEALTHY_PULLBACK" | "COUNTER_TREND_REBOUND" | "COUNTER_TREND_DECLINE" | "STRUCTURAL_BREAKDOWN";
export type IntelSetup = "PULLBACK_BUY" | "PULLBACK_SELL" | "BREAKOUT_BUY" | "BREAKOUT_SELL" | "RANGE_ONLY" | "NO_SETUP";
export type M5Momentum = "BULLISH" | "BEARISH" | "NONE" | "UNAVAILABLE";

export interface MarketIntelligenceReport {
  readonly version: typeof MARKET_INTELLIGENCE_VERSION;
  readonly bias: IntelBias;
  readonly market_phase: MarketPhase;
  readonly h4_state: string;
  readonly h1_state: H1State;
  readonly m15_condition: string;
  readonly m5_condition: string;
  readonly setup: IntelSetup;
  readonly status: DecisionStatus;
  readonly confidence: number;
  readonly confidence_breakdown: { readonly h4: number; readonly h1: number; readonly m15: number; readonly m5: number; readonly quality: number };
  readonly confirmation_needed: readonly string[];
  readonly invalidation_conditions: readonly string[];
  readonly risk_assessment: "LOW" | "MEDIUM" | "HIGH";
  readonly audit_trail: readonly string[];
  /** Structured fields for AI Copilot ingestion (descriptive only). */
  readonly key_levels: { readonly support?: number; readonly resistance?: number };
  readonly invalidation_levels: readonly number[];
  readonly reasons: readonly string[];
}

/** Weights (total 100) — every number explicit; changes bump MARKET_INTELLIGENCE_VERSION. */
export const INTEL_WEIGHTS = {
  H4_TREND: 35, H4_SIDEWAYS: 18, H4_TRANSITION: 10,
  H1_FOLLOW: 30, H1_HEALTHY_PULLBACK: 20, H1_COUNTER: 10, H1_BREAKDOWN: 0,
  M15_SUPPORTS: 20, M15_LOCATION_ONLY: 10,
  M5_TIMING: 10,
  QUALITY_OK: 5,
  /** READY needs confidence ≥ this plus zero outstanding confirmations. */
  READY_MIN_CONFIDENCE: 75,
  /** Below this ⇒ STAND_ASIDE; [this, READY_MIN) ⇒ WAIT_CONFIRMATION. */
  WAIT_MIN_CONFIDENCE: 50,
  LOW_RISK_MIN_CONFIDENCE: 75,
} as const;

export interface MarketIntelligenceInput {
  readonly h4: MarketStructure;
  readonly h1: MarketStructure;
  readonly m15: MarketStructure;
  /** Close of the latest CLOSED H1 / M15 bar. */
  readonly h1Close: number | null;
  readonly m15Close: number | null;
  readonly m5Momentum: M5Momentum;
  /** Regime volatility (injected from M1B.9); EXPANSION ⇒ quality filter fails (spike). */
  readonly volatility: "COMPRESSION" | "NORMAL" | "EXPANSION";
  readonly sweepDirection: "BULLISH" | "BEARISH" | null;
}

const px = (n: number | undefined | null) => (n == null ? "?" : String(Number(n.toFixed(5))));

export function evaluateMarketIntelligence(i: MarketIntelligenceInput): MarketIntelligenceReport {
  const W = INTEL_WEIGHTS;
  const audit: string[] = [];
  const confirm: string[] = [];
  const invalid: string[] = [];
  const hasStructure = (s: MarketStructure) => !!s.lastConfirmedHigh && !!s.lastConfirmedLow;

  if (!hasStructure(i.h4) || !hasStructure(i.h1) || i.h1Close === null || i.m15Close === null) {
    return Object.freeze({
      version: MARKET_INTELLIGENCE_VERSION, bias: "TRANSITION", market_phase: "RANGE", h4_state: "INSUFFICIENT_SWINGS",
      h1_state: "COUNTER_TREND_REBOUND", m15_condition: "—", m5_condition: "—", setup: "NO_SETUP", status: "NO_DATA", confidence: 0,
      confidence_breakdown: { h4: 0, h1: 0, m15: 0, m5: 0, quality: 0 },
      confirmation_needed: ["Swing H4/H1 terkonfirmasi (butuh histori CLOSED lebih banyak)"], invalidation_conditions: [],
      risk_assessment: "HIGH", audit_trail: ["Struktur H4/H1 belum punya swing high & low terkonfirmasi — tidak ada data yang dikarang."],
      key_levels: {}, invalidation_levels: [], reasons: ["Data candle CLOSED belum cukup untuk membaca struktur H4/H1."],
    });
  }

  // 1. H4 regime
  const h4 = i.h4;
  let bias: IntelBias;
  if (h4.trend === "HH_HL") bias = h4.structureShift === "BEARISH_MSS" ? "TRANSITION" : "BULLISH";
  else if (h4.trend === "LH_LL") bias = h4.structureShift === "BULLISH_MSS" ? "TRANSITION" : "BEARISH";
  else bias = h4.shiftDetected ? "TRANSITION" : "SIDEWAYS";
  const h4State = `${h4.trend}${h4.shiftDetected ? ` · ${h4.structureShift}` : ""}`;
  audit.push(bias === "BULLISH" ? `H4 higher low ${px(h4.lastConfirmedLow?.price)} bertahan di atas support; high terakhir ${px(h4.lastConfirmedHigh?.price)} > ${px(h4.previousHigh?.price)} → bias bullish.`
    : bias === "BEARISH" ? `H4 lower high ${px(h4.lastConfirmedHigh?.price)} menahan harga di bawah resistance; low terakhir ${px(h4.lastConfirmedLow?.price)} < ${px(h4.previousLow?.price)} → bias bearish.`
    : bias === "SIDEWAYS" ? `H4 range ${px(h4.lastConfirmedLow?.price)}–${px(h4.lastConfirmedHigh?.price)} tanpa struktur terarah.`
    : `H4 ${h4State}: swing kunci sudah dites/ditembus, continuation belum terkonfirmasi → fase transisi.`);
  const dir: "BULL" | "BEAR" | null = bias === "BULLISH" ? "BULL" : bias === "BEARISH" ? "BEAR" : null;

  // Phase
  const h1HigherLow = !!i.h1.lastConfirmedLow && !!i.h1.previousLow && i.h1.lastConfirmedLow.price > i.h1.previousLow.price;
  const h1LowerHigh = !!i.h1.lastConfirmedHigh && !!i.h1.previousHigh && i.h1.lastConfirmedHigh.price < i.h1.previousHigh.price;
  const phase: MarketPhase = bias === "TRANSITION" ? "TRANSITION"
    : dir ? "TRENDING"
    : bias === "SIDEWAYS" && i.h1.shiftDetected ? "TRANSITION"
    : bias === "SIDEWAYS" && i.sweepDirection === "BULLISH" && h1HigherLow ? "ACCUMULATION"
    : bias === "SIDEWAYS" && i.sweepDirection === "BEARISH" && h1LowerHigh ? "DISTRIBUTION" : "RANGE";
  if (phase === "ACCUMULATION") audit.push("Sweep likuiditas bawah + H1 higher low di dalam range H4 → akumulasi.");
  if (phase === "DISTRIBUTION") audit.push("Sweep likuiditas atas + H1 lower high di dalam range H4 → distribusi.");
  if (phase === "TRANSITION" && bias === "SIDEWAYS") audit.push(`Impuls berlawanan signifikan di dalam range H4 (H1 ${i.h1.structureShift}) → transisi.`);

  // 2. H1 structure relative to H4
  const h1 = i.h1;
  let h1State: H1State;
  const keyLevel = dir === "BULL" ? h4.lastConfirmedLow!.price : dir === "BEAR" ? h4.lastConfirmedHigh!.price : null;
  if (dir === "BULL") {
    if (i.h1Close < keyLevel!) h1State = "STRUCTURAL_BREAKDOWN";
    else if (h1.trend === "HH_HL") h1State = "FOLLOW_TREND";
    else if (h1.trend === "LH_LL" && i.m5Momentum === "BEARISH") h1State = "COUNTER_TREND_DECLINE";
    else h1State = "HEALTHY_PULLBACK";
  } else if (dir === "BEAR") {
    if (i.h1Close > keyLevel!) h1State = "STRUCTURAL_BREAKDOWN";
    else if (h1.trend === "LH_LL") h1State = "FOLLOW_TREND";
    else if (h1.trend === "HH_HL" && i.m5Momentum === "BULLISH") h1State = "COUNTER_TREND_REBOUND";
    else h1State = "HEALTHY_PULLBACK";
  } else {
    h1State = h1.trend === "HH_HL" ? "COUNTER_TREND_REBOUND" : h1.trend === "LH_LL" ? "COUNTER_TREND_DECLINE" : "FOLLOW_TREND";
  }
  audit.push(h1State === "STRUCTURAL_BREAKDOWN" ? `H1 close ${px(i.h1Close)} menembus level kunci H4 ${px(keyLevel)} → struktur H4 rusak, view ${dir === "BULL" ? "bullish" : "bearish"} batal.`
    : h1State === "HEALTHY_PULLBACK" ? `Koreksi H1 tanpa kerusakan struktur: level kunci H4 ${px(keyLevel)} masih utuh (H1 close ${px(i.h1Close)}) → pullback sehat.`
    : h1State === "FOLLOW_TREND" ? `H1 ${h1.trend} ${dir ? "searah H4" : "selaras dengan kondisi H4"}.`
    : `H1 ${h1.trend} counter-trend dengan momentum M5 masih mendorong koreksi.`);

  // 3. M15 setup location
  const m15 = i.m15;
  const m15Supports = dir === "BULL" ? m15.trend === "HH_HL" || m15.structureShift === "BULLISH_MSS"
    : dir === "BEAR" ? m15.trend === "LH_LL" || m15.structureShift === "BEARISH_MSS" : false;
  let setup: IntelSetup = "NO_SETUP";
  const setupAllowedH1 = h1State === "FOLLOW_TREND" || h1State === "HEALTHY_PULLBACK";
  if (dir && setupAllowedH1) {
    const brokeOut = dir === "BULL" ? !!m15.lastConfirmedHigh && i.m15Close > m15.lastConfirmedHigh.price
      : !!m15.lastConfirmedLow && i.m15Close < m15.lastConfirmedLow.price;
    setup = dir === "BULL" ? (brokeOut ? "BREAKOUT_BUY" : "PULLBACK_BUY") : (brokeOut ? "BREAKOUT_SELL" : "PULLBACK_SELL");
  } else if (bias === "SIDEWAYS") setup = "RANGE_ONLY";
  const m15Cond = setup === "NO_SETUP" ? `M15 ${m15.trend} · tidak ada setup` : setup === "RANGE_ONLY" ? `M15 ${m15.trend} · main di batas range`
    : `M15 ${m15.trend}${m15Supports ? " mendukung" : " belum mendukung"} ${setup.replace("_", " ")}`;
  audit.push(`Setup: ${setup}. ${m15Cond}.`);

  // 4. M5 timing
  const m5Aligned = dir === "BULL" ? i.m5Momentum === "BULLISH" : dir === "BEAR" ? i.m5Momentum === "BEARISH" : false;
  const m5Cond = i.m5Momentum === "UNAVAILABLE" ? "EMA M5 belum tersedia" : `Momentum M5 ${i.m5Momentum}${dir ? (m5Aligned ? " · searah" : " · belum searah") : ""}`;

  // 5. Quality
  const qualityOk = i.volatility !== "EXPANSION";
  if (!qualityOk) audit.push("Volatilitas EXPANSION (spike) → kualitas market tidak wajar.");

  const c = {
    h4: dir ? W.H4_TREND : bias === "SIDEWAYS" ? W.H4_SIDEWAYS : W.H4_TRANSITION,
    h1: h1State === "FOLLOW_TREND" ? (dir ? W.H1_FOLLOW : W.H1_HEALTHY_PULLBACK) : h1State === "HEALTHY_PULLBACK" ? W.H1_HEALTHY_PULLBACK : h1State === "STRUCTURAL_BREAKDOWN" ? W.H1_BREAKDOWN : W.H1_COUNTER,
    m15: m15Supports ? W.M15_SUPPORTS : setup !== "NO_SETUP" ? W.M15_LOCATION_ONLY : 0,
    m5: m5Aligned ? W.M5_TIMING : 0,
    quality: qualityOk ? W.QUALITY_OK : 0,
  };
  const confidence = c.h4 + c.h1 + c.m15 + c.m5 + c.quality;

  // Confirmations & status (confidence ≠ readiness)
  if (dir && setup !== "NO_SETUP") {
    if (h1State === "HEALTHY_PULLBACK") confirm.push(dir === "BULL" ? "H1 cetak higher low / kembali HH-HL" : "H1 cetak lower high / kembali LH-LL");
    if (!m15Supports) confirm.push(dir === "BULL" ? `M15 close di atas resistance ${px(m15.lastConfirmedHigh?.price)}` : `M15 close di bawah support ${px(m15.lastConfirmedLow?.price)}`);
    if (!m5Aligned) confirm.push(dir === "BULL" ? "Momentum M5 pulih ke bullish (EMA21 naik)" : "Momentum M5 kembali bearish (EMA21 turun)");
    if (!qualityOk) confirm.push("Volatilitas kembali normal");
  } else if (setup === "RANGE_ONLY") confirm.push(`Reaksi jelas di batas range H4 ${px(h4.lastConfirmedLow?.price)} / ${px(h4.lastConfirmedHigh?.price)}`);
  else if (bias === "TRANSITION") confirm.push("H4 konfirmasi continuation atau struktur baru");
  else if (h1State === "STRUCTURAL_BREAKDOWN" || !setupAllowedH1) confirm.push("H1 kembali searah H4 tanpa menembus level kunci");

  let status: DecisionStatus;
  if (h1State === "STRUCTURAL_BREAKDOWN" || bias === "TRANSITION" || setup === "NO_SETUP" || confidence < W.WAIT_MIN_CONFIDENCE) status = "STAND_ASIDE";
  else if (setup !== "RANGE_ONLY" && confirm.length === 0 && confidence >= W.READY_MIN_CONFIDENCE) status = "READY";
  else status = "WAIT_CONFIRMATION";

  // Invalidation
  if (dir === "BULL") {
    invalid.push(`H1 close di bawah demand kunci H4 ${px(h4.lastConfirmedLow?.price)} membatalkan view bullish`);
    invalid.push(`H4 cetak lower low di bawah ${px(h4.lastConfirmedLow?.price)} → struktur bullish rusak`);
    if (m15.lastConfirmedLow) invalid.push(`M15 close di bawah swing low ${px(m15.lastConfirmedLow.price)} → setup buy gugur`);
  } else if (dir === "BEAR") {
    invalid.push(`H1 close di atas supply kunci H4 ${px(h4.lastConfirmedHigh?.price)} membatalkan view bearish`);
    invalid.push(`H4 cetak higher high di atas ${px(h4.lastConfirmedHigh?.price)} → struktur bearish rusak`);
    if (m15.lastConfirmedHigh) invalid.push(`M15 close di atas swing high ${px(m15.lastConfirmedHigh.price)} → setup sell gugur`);
  } else {
    invalid.push(`H4 close keluar range ${px(h4.lastConfirmedLow?.price)}–${px(h4.lastConfirmedHigh?.price)} membatalkan skenario range`);
  }
  const lv = (n: number | undefined) => (n == null || !Number.isFinite(n) ? [] : [n]);
  const invalidationLevels = dir === "BULL" ? [...lv(h4.lastConfirmedLow?.price), ...lv(m15.lastConfirmedLow?.price)]
    : dir === "BEAR" ? [...lv(h4.lastConfirmedHigh?.price), ...lv(m15.lastConfirmedHigh?.price)]
    : [...lv(h4.lastConfirmedLow?.price), ...lv(h4.lastConfirmedHigh?.price)];
  const keyLevels = {
    ...(h4.lastConfirmedLow ? { support: h4.lastConfirmedLow.price } : {}),
    ...(h4.lastConfirmedHigh ? { resistance: h4.lastConfirmedHigh.price } : {}),
  };

  const risk = status === "STAND_ASIDE" || !qualityOk ? "HIGH" : status === "READY" && confidence >= W.LOW_RISK_MIN_CONFIDENCE ? "LOW" : "MEDIUM";
  audit.push(`Confidence ${confidence}/100 (H4 ${c.h4} · H1 ${c.h1} · M15 ${c.m15} · M5 ${c.m5} · Quality ${c.quality}) — confidence ≠ kesiapan entry.`);

  return Object.freeze({
    version: MARKET_INTELLIGENCE_VERSION, bias, market_phase: phase, h4_state: h4State, h1_state: h1State,
    m15_condition: m15Cond, m5_condition: m5Cond, setup, status, confidence, confidence_breakdown: Object.freeze(c),
    confirmation_needed: Object.freeze(confirm), invalidation_conditions: Object.freeze(invalid), risk_assessment: risk,
    audit_trail: Object.freeze(audit),
    key_levels: Object.freeze(keyLevels), invalidation_levels: Object.freeze(invalidationLevels), reasons: Object.freeze([...audit]),
  });
}
