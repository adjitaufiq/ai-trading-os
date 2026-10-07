// Phase 4A Journal Intelligence + similar-state retrieval (pure, descriptive only). Never changes rules or signals.
export interface TradeFact {
  trade_id: string; symbol: string; result: string; r_multiple: number | null; profit_loss_usd: number;
  regime: string | null; approach: string | null; location: string | null; trigger_pattern: string | null;
  failure_category: string | null; data_source: string | null; opened_at: string;
}
export interface MemoryFact {
  symbol: string; m5_close_at: string; regime: string | null; approach: string | null; decision: string | null;
  setup: string | null; bias: string | null; market_phase: string | null; confidence: number | null;
}

export interface Group { key: string; trades: number; wins: number; losses: number; winRate: number; avgR: number | null; totalR: number }

const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function group(trades: readonly TradeFact[], keyOf: (t: TradeFact) => string | null): Group[] {
  const m = new Map<string, TradeFact[]>();
  for (const t of trades) { const k = keyOf(t) ?? "UNKNOWN"; m.set(k, [...(m.get(k) ?? []), t]); }
  return [...m.entries()].map(([key, ts]) => {
    const rs = ts.map((t) => t.r_multiple).filter((x): x is number => typeof x === "number");
    const wins = ts.filter((t) => t.result === "WIN").length, losses = ts.filter((t) => t.result === "LOSS").length;
    return { key, trades: ts.length, wins, losses, winRate: r(wins / ts.length, 4), avgR: rs.length ? r(rs.reduce((a, b) => a + b, 0) / rs.length, 3) : null, totalR: r(rs.reduce((a, b) => a + b, 0), 3) };
  }).sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
}

export const MIN_SAMPLE = 5;

/** One data source at a time — statistics never mix REAL_MT5 with SYNTHETIC. */
export function journalIntelligence(all: readonly TradeFact[], dataSource = "REAL_MT5") {
  const trades = all.filter((t) => (t.data_source ?? "UNKNOWN") === dataSource);
  const overall = group(trades, () => "ALL")[0] ?? null;
  const losses = trades.filter((t) => t.result === "LOSS");
  return {
    data_source: dataSource,
    sample_note: trades.length < MIN_SAMPLE ? `Sampel kecil (${trades.length} trade) — belum layak disimpulkan.` : null,
    overall,
    by_regime: group(trades, (t) => t.regime),
    by_approach: group(trades, (t) => t.approach),
    by_setup: group(trades, (t) => `${t.location ?? "?"} + ${t.trigger_pattern ?? "?"}`),
    failure_patterns: group(losses, (t) => t.failure_category).map((g) => ({ category: g.key, count: g.trades })),
    excluded_other_sources: all.length - trades.length,
  };
}

/** Exact-field match on engine labels; no scoring model. Outcome = paper trades opened within `windowMin` after that state. */
export function similarStates(current: MemoryFact, history: readonly MemoryFact[], trades: readonly TradeFact[], limit = 5, windowMin = 60) {
  const matches = history.filter((h) => h.symbol === current.symbol && h.m5_close_at !== current.m5_close_at
    && h.regime === current.regime && h.decision === current.decision && (current.approach == null || h.approach === current.approach));
  return matches.slice(0, limit).map((h) => {
    const t0 = Date.parse(h.m5_close_at), t1 = t0 + windowMin * 60_000;
    const after = trades.filter((t) => t.symbol === h.symbol && Date.parse(t.opened_at) >= t0 && Date.parse(t.opened_at) < t1);
    return { at: h.m5_close_at, regime: h.regime, approach: h.approach, decision: h.decision, setup: h.setup, bias: h.bias, phase: h.market_phase, confidence: h.confidence,
      paper_outcome: after.length ? after.map((t) => ({ trade_id: t.trade_id, result: t.result, r: t.r_multiple })) : "NO_TRADE" };
  });
}
