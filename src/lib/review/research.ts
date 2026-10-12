// Research Intelligence V1 — post-trade analysis (pure, descriptive). Inputs: CLOSED paper trades + immutable reviews.
// Reads only labels the engine already recorded; never recomputes indicators, never emits signals, rules or parameters.
import type { TradeFact } from "@/lib/memory/analytics";
import type { ReviewFact } from "./performance";

export const RESEARCH_VERSION = "research-v1";
export const SETUP_MIN_SAMPLE = 20;
export const STRATEGY_MIN_SAMPLE = 50;

export interface ResearchTrade extends TradeFact { closed_at?: string | null }
export type RegimeBucket = "TREND" | "RANGE" | "HIGH_VOLATILITY" | "UNKNOWN";

const rd = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const setupOf = (t: TradeFact) => `${t.location ?? "?"} + ${t.trigger_pattern ?? "?"}`;

/** Exact-label projection of the recorded regime string onto the three research buckets. Unknown labels stay UNKNOWN. */
export function regimeBucket(label: string | null): RegimeBucket {
  const l = (label ?? "").toUpperCase();
  if (!l) return "UNKNOWN";
  if (/VOLATIL|EXPANSION/.test(l)) return "HIGH_VOLATILITY";
  if (/RANGE|SIDEWAYS|CONSOLIDAT|CHOP/.test(l)) return "RANGE";
  if (/TREND|IMPULS/.test(l)) return "TREND";
  return "UNKNOWN";
}

function latestReviews(reviews: readonly ReviewFact[]) {
  const m = new Map<string, ReviewFact>();
  for (const r of reviews) { const p = m.get(r.trade_id); if (!p || r.review_version > p.review_version) m.set(r.trade_id, r); }
  return m;
}

export interface TradeAttribution {
  trade_id: string; result: string; regime: RegimeBucket; setup: string; approach: string;
  entry_quality: string; win_factors: string[]; loss_factors: string[]; repeatable_pattern: string | null;
}

export function attributeTrade(t: TradeFact, review: ReviewFact | undefined, peers: readonly TradeFact[]): TradeAttribution {
  const regime = regimeBucket(t.regime), setup = setupOf(t), entry = review?.compliance_status ?? "UNREVIEWED";
  const win: string[] = [], loss: string[] = [];
  if (t.result === "WIN") {
    if (entry === "COMPLIANT") win.push("Entry sesuai aturan (compliance COMPLIANT)");
    if (regime !== "UNKNOWN") win.push(`Regime tercatat: ${regime}`);
    if (t.trigger_pattern) win.push(`Trigger: ${t.trigger_pattern}`);
    if (t.location) win.push(`Lokasi: ${t.location}`);
  } else if (t.result === "LOSS") {
    if (t.failure_category) loss.push(`Failure: ${t.failure_category}`);
    if (entry !== "COMPLIANT") loss.push(`Entry quality: ${entry}`);
    if (regime === "UNKNOWN") loss.push("Regime tidak tercatat");
    else loss.push(`Regime tercatat: ${regime}`);
  }
  const same = peers.filter((p) => setupOf(p) === setup && regimeBucket(p.regime) === regime && p.result === t.result);
  const repeatable = same.length >= 3 ? `${same.length} trade ${t.result} dengan setup "${setup}" di regime ${regime}` : null;
  return { trade_id: t.trade_id, result: t.result, regime, setup, approach: t.approach ?? "UNKNOWN", entry_quality: entry, win_factors: win, loss_factors: loss, repeatable_pattern: repeatable };
}

export interface Metrics {
  trades: number; expectancyR: number | null; profitFactor: number | null; maxDrawdownR: number; avgHoldingMinutes: number | null;
}

export function metrics(trades: readonly ResearchTrade[]): Metrics {
  const sorted = [...trades].sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  const rs = sorted.map((t) => t.r_multiple).filter((x): x is number => typeof x === "number");
  const gp = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const holds = sorted.flatMap((t) => { const o = Date.parse(t.opened_at), c = t.closed_at ? Date.parse(t.closed_at) : NaN; return Number.isFinite(o) && Number.isFinite(c) && c >= o ? [(c - o) / 60_000] : []; });
  return {
    trades: trades.length,
    expectancyR: rs.length ? rd(rs.reduce((a, b) => a + b, 0) / rs.length, 3) : null,
    profitFactor: gl > 0 ? rd(gp / gl, 2) : null,
    maxDrawdownR: rd(dd, 3),
    avgHoldingMinutes: holds.length ? rd(holds.reduce((a, b) => a + b, 0) / holds.length, 1) : null,
  };
}

function avgR(ts: readonly TradeFact[]) { const rs = ts.map((t) => t.r_multiple).filter((x): x is number => typeof x === "number"); return rs.length ? rd(rs.reduce((a, b) => a + b, 0) / rs.length, 3) : null; }
function byKey<T>(ts: readonly T[], k: (t: T) => string) { const m = new Map<string, T[]>(); for (const t of ts) m.set(k(t), [...(m.get(k(t)) ?? []), t]); return m; }

export interface SetupRow {
  setup: string; trades: number; status: "RANKED" | "INSUFFICIENT_SAMPLE";
  winRate: number | null; avgR: number | null; totalR: number | null; bestCondition: string | null; worstCondition: string | null; confidence: "LOW" | "MEDIUM" | "HIGH" | null;
}

export function setupPerformance(trades: readonly TradeFact[]): SetupRow[] {
  const rows: SetupRow[] = [...byKey(trades, setupOf).entries()].map(([setup, ts]) => {
    if (ts.length < SETUP_MIN_SAMPLE) return { setup, trades: ts.length, status: "INSUFFICIENT_SAMPLE", winRate: null, avgR: null, totalR: null, bestCondition: null, worstCondition: null, confidence: null };
    const conds = [...byKey(ts, (t) => regimeBucket(t.regime)).entries()].filter(([k, g]) => k !== "UNKNOWN" && g.length >= 5).map(([k, g]) => ({ k, a: avgR(g) ?? 0 })).sort((a, b) => b.a - a.a);
    const rs = ts.map((t) => t.r_multiple ?? 0);
    return {
      setup, trades: ts.length, status: "RANKED", winRate: rd(ts.filter((t) => t.result === "WIN").length / ts.length, 4),
      avgR: avgR(ts), totalR: rd(rs.reduce((a, b) => a + b, 0), 3),
      bestCondition: conds[0]?.k ?? null, worstCondition: conds.length > 1 ? conds.at(-1)?.k ?? null : null,
      confidence: ts.length >= 100 ? "HIGH" : ts.length >= STRATEGY_MIN_SAMPLE ? "MEDIUM" : "LOW",
    };
  });
  // Only RANKED rows are ordered by performance; insufficient rows are listed by sample size and never ranked.
  const ranked = rows.filter((r) => r.status === "RANKED").sort((a, b) => (b.avgR ?? 0) - (a.avgR ?? 0));
  const rest = rows.filter((r) => r.status !== "RANKED").sort((a, b) => b.trades - a.trades || a.setup.localeCompare(b.setup));
  return [...ranked, ...rest];
}

export interface RegimeMemory {
  regime: RegimeBucket; trades: number; status: "OK" | "INSUFFICIENT_SAMPLE";
  bestSetup: string | null; worstSetup: string | null; avgR: number | null; failurePattern: string | null;
}

export function regimeMemory(trades: readonly TradeFact[]): RegimeMemory[] {
  return (["TREND", "RANGE", "HIGH_VOLATILITY"] as const).map((regime) => {
    const ts = trades.filter((t) => regimeBucket(t.regime) === regime);
    if (ts.length < SETUP_MIN_SAMPLE) return { regime, trades: ts.length, status: "INSUFFICIENT_SAMPLE", bestSetup: null, worstSetup: null, avgR: null, failurePattern: null };
    const setups = [...byKey(ts, setupOf).entries()].filter(([, g]) => g.length >= 5).map(([k, g]) => ({ k, a: avgR(g) ?? 0 })).sort((a, b) => b.a - a.a);
    const fails = [...byKey(ts.filter((t) => t.result === "LOSS" && t.failure_category), (t) => t.failure_category as string).entries()].sort((a, b) => b[1].length - a[1].length);
    return { regime, trades: ts.length, status: "OK", bestSetup: setups[0]?.k ?? null, worstSetup: setups.length > 1 ? setups.at(-1)?.k ?? null : null, avgR: avgR(ts), failurePattern: fails[0]?.[0] ?? null };
  });
}

export function researchIntelligence(all: readonly ResearchTrade[], reviews: readonly ReviewFact[], dataSource = "REAL_MT5") {
  const trades = all.filter((t) => (t.data_source ?? "UNKNOWN") === dataSource && (t.result === "WIN" || t.result === "LOSS" || t.result === "BREAKEVEN"));
  const rev = latestReviews(reviews);
  const sufficient = trades.length >= STRATEGY_MIN_SAMPLE;
  return {
    version: RESEARCH_VERSION, data_source: dataSource, closed_trades: trades.length,
    strategy_evaluation: sufficient ? "SUFFICIENT_DATA" as const : "INSUFFICIENT_DATA" as const,
    conclusion_allowed: sufficient,
    note: sufficient ? null : `INSUFFICIENT DATA — NO CONCLUSION (${trades.length}/${STRATEGY_MIN_SAMPLE} closed trades).`,
    metrics: metrics(trades),
    setups: setupPerformance(trades),
    regimes: regimeMemory(trades),
    attributions: [...trades].sort((a, b) => b.opened_at.localeCompare(a.opened_at)).slice(0, 20).map((t) => attributeTrade(t, rev.get(t.trade_id), trades)),
  };
}

export type ResearchReport = ReturnType<typeof researchIntelligence>;
