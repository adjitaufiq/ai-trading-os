import { analyzeFailureDistribution } from "../autopsy/patternAnalyzer";
import type { TradeAutopsy } from "../autopsy/types";
import { buildEquityCurve } from "../journal/equityAnalytics";
import { calculatePerformance } from "../journal/metricsEngine";
import type { JournalTrade } from "../journal/types";
import type { PipelineCounters, ScenarioStats, StressMetrics } from "./types";

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function emptyCounters(): PipelineCounters {
  return { barsProcessed: 0, evaluations: 0, noSetup: {}, setupsCreated: 0, setupsInvalidated: 0, setupsExpired: 0, plansPlanned: 0, planHolds: {}, riskApproved: 0, riskBlocked: {}, paperRejected: {}, tradesOpened: 0, tradesClosed: 0 };
}
export const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

export function computeStressMetrics(trades: readonly JournalTrade[], autopsies: readonly TradeAutopsy[], counters: PipelineCounters, initialEquity: number): StressMetrics {
  const p = calculatePerformance(trades);
  const eq = buildEquityCurve(trades, initialEquity);
  const rOf = (t: JournalTrade, v: number) => { const R = Math.abs(t.entryPrice - t.stopLoss); return R > 0 ? v / R : 0; };
  const withEx = trades.filter((t) => t.excursion);
  const d = analyzeFailureDistribution(autopsies);
  const rejects = Object.values(counters.riskBlocked).reduce((a, b) => a + b, 0) + Object.values(counters.paperRejected).reduce((a, b) => a + b, 0);
  return {
    totalTrades: p.totalTrades, winRate: p.winRate, profitFactor: Number.isFinite(p.profitFactor) ? r4(p.profitFactor) : p.profitFactor,
    expectancy: p.expectancyR, maxDrawdown: eq.maxDrawdownPercent,
    averageMAE: r4(mean(withEx.map((t) => rOf(t, t.excursion!.maximumAdverseExcursion)))),
    averageMFE: r4(mean(withEx.map((t) => rOf(t, t.excursion!.maximumFavorableExcursion)))),
    failureDistribution: Object.entries(d.breakdown).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0) || a[0].localeCompare(b[0])).map(([k, v]) => `${k}: ${Math.round((v ?? 0) * 100)}%`),
    executionRejectRate: counters.plansPlanned ? r4(rejects / counters.plansPlanned) : 0,
  };
}

export function scenarioStats(trades: readonly JournalTrade[], scenarioOf: ReadonlyMap<string, string>): ScenarioStats[] {
  const groups = new Map<string, JournalTrade[]>();
  for (const t of trades) { const k = scenarioOf.get(t.tradeId) ?? "UNKNOWN"; groups.set(k, [...(groups.get(k) ?? []), t]); }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, ts]) => {
    const p = calculatePerformance(ts);
    return { scenario: k as ScenarioStats["scenario"], trades: ts.length, winRate: p.winRate, expectancyR: p.expectancyR };
  });
}
