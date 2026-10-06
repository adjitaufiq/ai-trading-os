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
}

export const STRESS_POLICY_VERSION = "stress-m7-v1";

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
  RISK_PERCENT: 1,
  MAX_DAILY_LOSS_PERCENT: 5,
  MAX_SLIPPAGE: 0.5,
} as const;

export const PHASES = [
  { phase: 1, sampleSize: 100, purpose: "System sanity check" },
  { phase: 2, sampleSize: 500, purpose: "Failure distribution analysis" },
  { phase: 3, sampleSize: 1000, purpose: "Baseline expectancy" },
] as const;
