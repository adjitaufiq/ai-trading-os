import { groupStats } from "../journal/setupAnalytics";
import type { JournalTrade } from "../journal/types";
import type { FailureCategory, FailureDistribution, RuleAudit, TradeAutopsy } from "./types";

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function analyzeFailureDistribution(autopsies: readonly TradeAutopsy[]): FailureDistribution {
  const losses = autopsies.filter((a) => a.result === "LOSS");
  const counts = new Map<FailureCategory, number>();
  for (const a of losses) counts.set(a.primaryFailure, (counts.get(a.primaryFailure) ?? 0) + 1);
  const breakdown: Partial<Record<FailureCategory, number>> = {};
  for (const [k, v] of counts) breakdown[k] = r4(v / losses.length);
  const top = [...counts.entries()].filter(([k]) => k !== "UNCLASSIFIED").sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { analyzed: autopsies.length, losses: losses.length, breakdown, highestImpact: top ? top[0] : null };
}

/** Descriptive per-condition audit (location + trigger). expectancy is in R. */
export function buildRuleAuditMatrix(trades: readonly JournalTrade[]): RuleAudit[] {
  return groupStats(trades, (t) => `${t.context.priceLocation} + ${t.context.triggerPattern}`).map((g) => {
    const losses = trades.filter((t) => `${t.context.priceLocation} + ${t.context.triggerPattern}` === g.key && t.result === "LOSS").length;
    return { condition: g.key, sampleSize: g.trades, winRate: g.winRate, failureRate: r4(losses / g.trades), expectancy: g.expectancyR };
  });
}
