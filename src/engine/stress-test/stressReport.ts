import { AUTOPSY_PARAMS } from "../autopsy/types";
import { EMA_PARAMS } from "../core/ema/types";
import { LOCATION_PARAMS } from "../core/location/types";
import { SWING_PARAMS } from "../core/swing/types";
import type { TradeAutopsy } from "../autopsy/types";
import type { JournalTrade } from "../journal/types";
import { PLAN_PARAMS } from "../plan/types";
import { RISK_PARAMS } from "../risk/types";
import { SIGNAL_PARAMS } from "../signal/types";
import { SCENARIO_PURPOSE, type HealthCheck, type PipelineCounters, type StressRunResult } from "./types";

/** Serialized strategy params; compared before/after a run to prove M7 changed nothing. */
export function snapshotParams(): string {
  return JSON.stringify({ SWING_PARAMS, LOCATION_PARAMS, EMA_PARAMS, SIGNAL_PARAMS, PLAN_PARAMS, RISK_PARAMS, AUTOPSY_PARAMS });
}

export interface HealthInput {
  terminalRevivals: number; riskViolations: number; minEquity: number; counters: PipelineCounters;
  trades: readonly JournalTrade[]; autopsies: readonly TradeAutopsy[];
  journalHashBefore: string; journalHashAfter: string; paramsBefore: string; paramsAfter: string;
}

export function buildHealthChecks(h: HealthInput): HealthCheck[] {
  const ids = new Set(h.trades.map((t) => t.tradeId));
  const frozen = h.trades.every((t) => Object.isFrozen(t));
  const journalOk = ids.size === h.trades.length && h.trades.length === h.counters.tradesClosed && frozen && h.journalHashBefore === h.journalHashAfter;
  const autopsyOk = h.autopsies.length === h.trades.length && h.autopsies.every((a) => a.evidence.length > 0);
  const c = (name: string, ok: boolean, detail: string): HealthCheck => ({ name, status: ok ? "PASS" : "FAIL", detail });
  return [
    c("Signal Stability", h.terminalRevivals === 0, `${h.counters.setupsCreated} setups, ${h.terminalRevivals} id re-creations`),
    c("Risk Protection", h.riskViolations === 0 && h.minEquity > 0, `${h.riskViolations} budget violations, min equity ${Math.round(h.minEquity * 100) / 100}`),
    c("Journal Integrity", journalOk, `${h.trades.length} rows, unique=${ids.size === h.trades.length}, frozen=${frozen}`),
    c("Autopsy Coverage", autopsyOk, `${h.autopsies.length}/${h.trades.length} trades autopsied with evidence`),
    c("Parameter Immutability", h.paramsBefore === h.paramsAfter, h.paramsBefore === h.paramsAfter ? "no strategy param changed" : "PARAM DRIFT"),
  ];
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function generateStressReport(r: StressRunResult): string {
  if (!r.ok) return `ARENA STRESS TEST REPORT\nERROR: ${r.error}`;
  const m = r.metrics;
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞";
  return [
    "ARENA STRESS TEST REPORT", `Data: ${r.dataLabel} (${r.config.mode}, seed ${r.config.seed ?? "-"})`,
    `Sample: ${m.totalTrades} trades${r.sampleReached ? "" : ` (target ${Math.min(r.config.sampleSize, r.config.maxTrades)} NOT reached — bar budget exhausted)`}`,
    "", "Performance:", `Win Rate: ${pct(m.winRate)}`, `Profit Factor: ${pf}`, `Expectancy: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy}R`,
    `Avg MAE: ${m.averageMAE}R | Avg MFE: ${m.averageMFE}R`,
    "", "Risk:", `Maximum DD: ${m.maxDrawdown}%`, `Execution Reject Rate: ${pct(m.executionRejectRate)}`,
    "", "Failure Analysis (losses):", ...(m.failureDistribution.length ? m.failureDistribution : ["none"]),
    `Highest Impact Issue: ${r.highestImpact ?? "none"}`,
    "", "By Scenario:", ...r.byScenario.map((s) => `${s.scenario}: ${s.trades} trades, WR ${pct(s.winRate)}, ${s.expectancyR}R${s.scenario in SCENARIO_PURPOSE ? ` — measures ${SCENARIO_PURPOSE[s.scenario as keyof typeof SCENARIO_PURPOSE]}` : ""}`),
    "", "Pipeline:", `Bars ${r.counters.barsProcessed} | Setups ${r.counters.setupsCreated} | Plans ${r.counters.plansPlanned} | Risk OK ${r.counters.riskApproved} | Opened ${r.counters.tradesOpened}`,
    `Plan HOLDs: ${JSON.stringify(r.counters.planHolds)}`, `Risk blocks: ${JSON.stringify(r.counters.riskBlocked)}`,
    "", "System Health:", ...r.health.map((h) => `${h.name}: ${h.status} (${h.detail})`),
    "", "Note: WHAT FAILED only — no parameter recommendation is applied (M8 scope).",
  ].join("\n");
}

export type { StressRunResult };
