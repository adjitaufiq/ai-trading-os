// Phase 5B Performance Intelligence (pure, descriptive). Inputs: CLOSED paper trades + immutable trade reviews only.
// Never produces signals, rule changes or parameter suggestions. One data source at a time (no REAL_MT5/SYNTHETIC mix).
import { MIN_SAMPLE, type Group, type TradeFact } from "@/lib/memory/analytics";

export interface ReviewFact { trade_id: string; compliance_status: string; review_version: string }

const rd = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export interface PerfGroup extends Group { sufficient: boolean }

function group(trades: readonly TradeFact[], keyOf: (t: TradeFact) => string | null): PerfGroup[] {
  const m = new Map<string, TradeFact[]>();
  for (const t of trades) { const k = keyOf(t) ?? "UNKNOWN"; m.set(k, [...(m.get(k) ?? []), t]); }
  return [...m.entries()].map(([key, ts]) => {
    const rs = ts.map((t) => t.r_multiple).filter((x): x is number => typeof x === "number");
    const wins = ts.filter((t) => t.result === "WIN").length, losses = ts.filter((t) => t.result === "LOSS").length;
    const totalR = rs.reduce((a, b) => a + b, 0);
    return { key, trades: ts.length, wins, losses, winRate: rd(wins / ts.length, 4), avgR: rs.length ? rd(totalR / rs.length, 3) : null, totalR: rd(totalR, 3), sufficient: ts.length >= MIN_SAMPLE };
  }).sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
}

export function performanceIntelligence(allTrades: readonly TradeFact[], reviews: readonly ReviewFact[], dataSource = "REAL_MT5") {
  const trades = allTrades.filter((t) => (t.data_source ?? "UNKNOWN") === dataSource);
  // Latest review version per trade (lexicographic version string); unreviewed trades stay UNREVIEWED.
  const rev = new Map<string, ReviewFact>();
  for (const r of reviews) { const p = rev.get(r.trade_id); if (!p || r.review_version > p.review_version) rev.set(r.trade_id, r); }
  const losses = trades.filter((t) => t.result === "LOSS");
  const failure = group(losses, (t) => t.failure_category).map((g) => ({ category: g.key, count: g.trades, share: losses.length ? rd(g.trades / losses.length, 4) : 0 }));
  const reviewed = trades.filter((t) => rev.has(t.trade_id)).length;
  return {
    data_source: dataSource,
    min_sample: MIN_SAMPLE,
    sample_note: trades.length < MIN_SAMPLE ? `Sampel kecil (${trades.length} trade) — belum layak disimpulkan.` : null,
    summary: group(trades, () => "ALL")[0] ?? null,
    reviewed_trades: reviewed,
    unreviewed_trades: trades.length - reviewed,
    by_regime: group(trades, (t) => t.regime),
    by_approach: group(trades, (t) => t.approach),
    by_setup: group(trades, (t) => `${t.location ?? "?"} + ${t.trigger_pattern ?? "?"}`),
    compliance_vs_outcome: group(trades, (t) => rev.get(t.trade_id)?.compliance_status ?? "UNREVIEWED"),
    failure_distribution: failure,
    excluded_other_sources: allTrades.length - trades.length,
  };
}

export type PerformanceReport = ReturnType<typeof performanceIntelligence>;
