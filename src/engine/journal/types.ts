import type { FootprintSnapshot } from "../core/market/institutional-radar/types";
import type { MarketRegimeType } from "../core/market/regime/types";
import type { MarketApproach, TradingHorizon } from "../core/market/horizon/types";
import type { EventReference } from "../signal/context";
import type { AssetClass } from "../../core/broker/types";
import type { MarketSession } from "../../core/temporal/MarketSessionResolver";
import type { FailureCategory } from "../contracts/diagnostics";
import type { DataSource } from "../contracts/dataSource";
export type { DataSource };
export type { FailureCategory };

export interface JournalContextSnapshot {
  readonly regime: MarketRegimeType | null;
  readonly horizon: TradingHorizon | null;
  readonly marketApproach: MarketApproach | null;
  readonly footprintTags: readonly string[];
  readonly eventReferences: readonly EventReference[];
}
// M6 — Trade journal & performance analytics contracts.
// READ-ONLY analysis layer: never changes rules, params, risk, signals or history.

export type TradeOutcome = "WIN" | "LOSS" | "BREAK_EVEN";

export interface JournalContext {
  bias: string;
  h1Phase: string;
  priceLocation: string;
  locationTier: string;
  triggerPattern: string;
  reactionQuality: string;
  emaContext: string;
  rr: number;
}

export interface ExcursionMetrics {
  maximumAdverseExcursion: number;
  maximumFavorableExcursion: number;
}

export interface JournalTrade {
  tradeId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  executionMode: "PAPER";
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  lot: number;
  riskUSD: number;
  profitLossUSD: number;
  profitLossPercent: number;
  result: TradeOutcome;
  closeReason: string;
  durationSeconds: number;
  context: JournalContext;
  decisionTrace: string[];
  openedAt: number;
  closedAt: number;
  excursion?: ExcursionMetrics;
  /** M1B.8 evidence snapshot for M8 research; optional, descriptive only. */
  footprints?: FootprintSnapshot;
  /** m2-context-v1 summary carried from the signal; descriptive only. */
  readonly contextSnapshot?: JournalContextSnapshot;
  readonly assetClass: AssetClass;
  /** Session at openedAt. */
  readonly session: MarketSession;
  readonly plannedEntryPrice: number;
  readonly actualEntryPrice: number;
  /** Positive = adverse fill, negative = price improvement. */
  readonly slippagePoints: number;
  /** 0 for paper execution; never undefined. */
  readonly latencyMs: number;
  readonly primaryFailureCategory?: FailureCategory;
  /** Origin of the market data; always set by fromPaperTrade. Statistics must never mix sources. */
  readonly dataSource?: DataSource;
  /** PrimaryBias → M2: H4 primaryBias at setup gate (optional; absent on legacy rows). */
  readonly primaryBias?: "BUY" | "SELL" | "NONE";
  /** Epoch ms of the primaryBias evaluation. */
  readonly primaryBiasAsOf?: number;
  readonly primaryBiasSource?: "TECHNICAL_H4_CLOSED";
  /** Decision Gate snapshot frozen at OPEN (copy of existing outputs; null = not available). Optional, append-only. */
  readonly entryDecision?: EntryDecisionSnapshot;
}

/** Facts available at entry, copied verbatim. No field is recomputed; missing values stay null. */
export interface EntryDecisionSnapshot {
  readonly gatePolicyVersion: string;
  readonly decision: "ALLOW";
  readonly reason: string;
  readonly arenaStatus: string | null;
  readonly candidateDirection: "BUY" | "SELL";
  readonly signalId: string;
  readonly decidedAt: number;
  readonly primaryBias: "BUY" | "SELL" | "NONE" | null;
  readonly m1bBias: string | null;
  readonly m15Structure: string | null;
  readonly m15StructureShift: string | null;
  readonly priceLocation: string | null;
  readonly locationTier: string | null;
  readonly trigger: string | null;
  readonly reactionQuality: string | null;
  readonly plannedEntry: number | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly plannedRr: number | null;
  readonly lot: number | null;
  readonly riskUSD: number | null;
  /** Hardening V1: regime label frozen at entry (engine M1B.9 mapping; UNCERTAIN when absent). Copy-only. */
  readonly regime?: string | null;
}

export type SaveError = "DUPLICATE_TRADE_ID" | "INVALID_TRADE";
export type SaveResult = { ok: true; trade: Readonly<JournalTrade> } | { ok: false; error: SaveError };

export interface PerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** Fraction 0..1. */
  winRate: number;
  totalProfit: number;
  /** Positive magnitude of losses. */
  totalLoss: number;
  /** totalProfit / totalLoss; Infinity when no losses and profit > 0; 0 when empty. */
  profitFactor: number;
  averageRiskReward: number;
  /** USD per trade: winRate×avgWin − lossRate×avgLoss. */
  expectancy: number;
  /** Mean of pnl/riskUSD. */
  expectancyR: number;
  averageWin: number;
  /** Positive magnitude. */
  averageLoss: number;
}

export interface GroupStats {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  expectancy: number;
  expectancyR: number;
  totalR: number;
}

export interface JournalFilter {
  symbol?: string;
  direction?: "BUY" | "SELL";
  result?: TradeOutcome;
  location?: string;
  trigger?: string;
  closeReason?: string;
  dateRange?: { from: number; to: number };
}

export interface EquityPoint { timestamp: number; equity: number; drawdownPercent: number }
export interface EquitySummary { points: EquityPoint[]; peakEquity: number; currentEquity: number; maxDrawdownPercent: number }

export const JOURNAL_POLICY_VERSION = "journal-m6-v1";

export const JOURNAL_RULES = {
  STORAGE: "append-only; unique tradeId; duplicates rejected; stored trades deep-frozen",
  OUTCOME: "pnl > 0 WIN, < 0 LOSS, = 0 BREAK_EVEN",
  EXPECTANCY: "winRate×avgWin − lossRate×avgLoss (BREAK_EVEN counts in denominator only)",
  EXCURSION: "BUY: MAE = low − entry (≤0), MFE = high − entry; SELL mirrored; candles between open and close only",
  FORBIDDEN: "no strategy change, no optimization, no parameter change, no AI decisions",
} as const;
