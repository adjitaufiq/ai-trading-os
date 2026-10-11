import type { JournalTrade } from "../journal/types";
import { DEFAULT_RISK_POLICY, riskPercentOf } from "../risk/riskPolicy";
// M7 — Automation stress test contracts.
// MEASUREMENT ONLY: runs the existing M1B→M6.5 chain unattended on SIMULATED
// (or supplied historical) candles. Never changes EMA/SL/RR/risk params, never
// filters losing setups, never optimizes. Output = "what failed", not "change this".

import type { RawGatewayPayload } from "../core/normalizer/types";

export type StressMode = "RANDOM" | "HISTORICAL_REPLAY" | "MONTE_CARLO";

export interface StressTestConfig {
  symbol: string;
  mode: StressMode;
  sampleSize: number;
  initialEquity: number;
  maxTrades: number;
  disableHumanApproval: boolean;
  /** PRNG seed for RANDOM / MONTE_CARLO (deterministic). */
  seed?: number;
  /** Required for HISTORICAL_REPLAY: raw M5 payloads (oldest first). */
  historicalBars?: readonly RawGatewayPayload[];
  /** Hard bar budget; run stops even if sampleSize not reached. */
  maxBars?: number;
  /** Attach M1B.8–11 observational context (m2-context-v1). Default true; never changes decisions. */
  captureContext?: boolean;
}

export const DEFAULT_STRESS_CONFIG: StressTestConfig = {
  symbol: "XAUUSD", mode: "MONTE_CARLO", sampleSize: 1000, initialEquity: 10000, maxTrades: 1000,
  disableHumanApproval: true, seed: 1,
};

export type MarketScenario =
  | "NORMAL_TREND"
  | "RANGE_MARKET"
  | "HIGH_VOLATILITY"
  | "FALSE_BREAKOUT"
  | "LIQUIDITY_HUNT"
  | "LOW_LIQUIDITY";

export const ALL_SCENARIOS: readonly MarketScenario[] = [
  "NORMAL_TREND", "RANGE_MARKET", "HIGH_VOLATILITY", "FALSE_BREAKOUT", "LIQUIDITY_HUNT", "LOW_LIQUIDITY",
];

export const SCENARIO_PURPOSE: Record<MarketScenario, string> = {
  NORMAL_TREND: "trend following, pullback entry",
  RANGE_MARKET: "mid-range filtering, S/R reaction",
  HIGH_VOLATILITY: "spread guard, SL protection",
  FALSE_BREAKOUT: "breakout waiting, invalidation logic",
  LIQUIDITY_HUNT: "SL sweep frequency, M15 buffer adequacy",
  LOW_LIQUIDITY: "wide spread / thin movement handling",
};

export interface StressMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  /** R per trade. */
  expectancy: number;
  /** Percent. */
  maxDrawdown: number;
  /** In R (MAE ≤ 0). */
  averageMAE: number;
  /** In R. */
  averageMFE: number;
  failureDistribution: string[];
  /** (risk non-APPROVED + paper REJECTED) / PLANNED plans. */
  executionRejectRate: number;
}

export interface PipelineCounters {
  barsProcessed: number;
  evaluations: number;
  noSetup: Record<string, number>;
  setupsCreated: number;
  setupsInvalidated: number;
  setupsExpired: number;
  plansPlanned: number;
  planHolds: Record<string, number>;
  riskApproved: number;
  riskBlocked: Record<string, number>;
  paperRejected: Record<string, number>;
  tradesOpened: number;
  tradesClosed: number;
}

export type HealthStatus = "PASS" | "FAIL";
export interface HealthCheck { name: string; status: HealthStatus; detail: string }

export interface ScenarioStats { scenario: MarketScenario | "HISTORICAL"; trades: number; winRate: number; expectancyR: number }

export interface StressRunResult {
  ok: boolean;
  error?: "HUMAN_APPROVAL_NOT_AUTOMATABLE" | "HISTORICAL_BARS_REQUIRED" | "INVALID_CONFIG";
  config: StressTestConfig;
  dataLabel: "SIMULATION_SYNTHETIC" | "HISTORICAL_REPLAY";
  metrics: StressMetrics;
  counters: PipelineCounters;
  health: HealthCheck[];
  byScenario: ScenarioStats[];
  highestImpact: string | null;
  sampleReached: boolean;
  policyVersion: string;
  /** Context-aware replay output (null when captureContext=false). */
  context: ContextReport | null;
  /** Frozen journal rows of this run (read-only copy for validation). */
  trades?: readonly JournalTrade[];
  /** M5 gaps accepted because the calendar declared the market closed. */
  calendarGapsAccepted?: number;
}

export interface ContextCounters {
  observedBars: number;
  regime: Record<string, number>;
  horizon: Record<string, number>;
  regimeFlips: number;
  /** New events by type (first occurrence only). */
  eventsCreated: Record<string, number>;
  /** Ended events keyed TYPE:REASON. */
  eventsEnded: Record<string, number>;
  maxTrackers: number;
  revisions: number;
  /** Any sensor output stamped after the observing bar close (must stay 0). */
  causalityViolations: number;
  /** Bars where a footprint flag was observed. */
  footprintBars: Record<string, number>;
}

/** Descriptive group statistics — NOT a score, never fed back into any engine. */
export interface ContextBucket { key: string; trades: number; wins: number; losses: number; winRate: number; expectancyR: number }

export interface ContextAudit {
  contextCoverage: number;
  eventsPer1000Bars: number;
  regimeFlipsPer1000Bars: number;
  noFitRate: number;
  maxTrackers: number;
  causalityViolations: number;
}

export interface ContextReport {
  counters: ContextCounters;
  byRegime: ContextBucket[];
  byHorizon: ContextBucket[];
  byFootprint: ContextBucket[];
  byEvent: ContextBucket[];
  /** LIQUIDITY_SWEEP lifecycle: resolved by REACTION_CONFIRMED vs expired. */
  sweepImpact: { created: number; resolved: number; expired: number; tradesWithActiveSweep: number; avgOutcomeR: number };
  audit: ContextAudit;
  contextVersion: "m2-context-v1";
}

export const STRESS_POLICY_VERSION = "stress-m7-v2-context";

/** Simulation environment constants (NOT strategy params). */
export const STRESS_ENV = {
  START_TS: 1704067200, // 2024-01-01T00:00:00Z, H4-aligned
  SEGMENT_BARS: 1500,
  MONTE_CARLO_PATH_BARS: 6000,
  BAR_BUDGET_PER_TRADE: 800,
  BASE_PRICE: 2650,
  SPREAD_NORMAL: 0.2,
  EMA_WINDOW_M5: 300,
  M15_WINDOW: 120,
  SWING_WINDOW: 40,
  SPREAD_HISTORY: 20,
  AUTOPSY_LOOKAHEAD_BARS: 10,
  BROKER: { volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, marginPerLot: 1000 },
  /** Phase 4A.1: same single policy as paper and demo (risk-policy.json, 0.5%). */
  RISK_PERCENT: riskPercentOf(DEFAULT_RISK_POLICY),
  MAX_DAILY_LOSS_PERCENT: 5,
  MAX_SLIPPAGE: 0.5,
  /** Rolling M15 ATR history injected into M1B.9 (environment window, not a strategy param). */
  ATR_HISTORY: 200,
  /** Upper bound on live event trackers per symbol for the memory health check. */
  MAX_EVENT_TRACKERS: 64,
} as const;

export const PHASES = [
  { phase: 1, sampleSize: 100, purpose: "System sanity check" },
  { phase: 2, sampleSize: 500, purpose: "Failure distribution analysis" },
  { phase: 3, sampleSize: 1000, purpose: "Baseline expectancy" },
] as const;
