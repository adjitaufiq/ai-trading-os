import { calculatePerformance } from "./metricsEngine";
import type { GroupStats, JournalTrade } from "./types";

export function groupStats(trades: readonly JournalTrade[], keyOf: (t: JournalTrade) => string): GroupStats[] {
  const m = new Map<string, JournalTrade[]>();
  for (const t of trades) { const k = keyOf(t); m.set(k, [...(m.get(k) ?? []), t]); }
  return [...m.entries()].map(([key, ts]) => {
    const p = calculatePerformance(ts);
    const totalR = ts.filter((t) => t.riskUSD > 0).reduce((s, t) => s + t.profitLossUSD / t.riskUSD, 0);
    return { key, trades: ts.length, wins: p.winningTrades, winRate: p.winRate, expectancy: p.expectancy, expectancyR: p.expectancyR, totalR: Math.round(totalR * 10000) / 10000 };
  }).sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
}

export function analyzeBySetup(trades: readonly JournalTrade[]) {
  return {
    byLocation: groupStats(trades, (t) => t.context.priceLocation),
    byTrigger: groupStats(trades, (t) => t.context.triggerPattern),
    byReactionQuality: groupStats(trades, (t) => t.context.reactionQuality),
    byLocationTrigger: groupStats(trades, (t) => `${t.context.priceLocation} + ${t.context.triggerPattern}`),
  };
}

export function analyzeByBias(trades: readonly JournalTrade[]): GroupStats[] {
  return groupStats(trades, (t) => `${t.context.bias} | ${t.context.h1Phase}`);
}

/** Descriptive only; groups under minTrades are ignored to avoid tiny-sample claims. */
export function bestAndWorst(groups: readonly GroupStats[], minTrades = 1): { best: GroupStats | null; worst: GroupStats | null } {
  const g = groups.filter((x) => x.trades >= minTrades);
  if (!g.length) return { best: null, worst: null };
  const sorted = [...g].sort((a, b) => b.winRate - a.winRate || b.expectancyR - a.expectancyR || a.key.localeCompare(b.key));
  return { best: sorted[0]!, worst: sorted[sorted.length - 1]! };
}
