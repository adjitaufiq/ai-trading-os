// M5 — Paper execution engine contracts.
// SIMULATION ONLY: no broker API, no real orders. SL/TP/lot/risk frozen at open.

export type ExecutionState = "IDLE" | "PENDING" | "OPEN" | "PARTIAL" | "CLOSED" | "REJECTED";
export type CloseReason = "TP_HIT" | "SL_HIT" | "MANUAL_CLOSE" | "INVALIDATED" | "EXPIRED" | "BROKER_SIM_ERROR";
export type TradeDirection = "BUY" | "SELL";
export type RejectReason = "RISK_NOT_APPROVED" | "INVALID_PLAN" | "INVALID_MARKET_PRICE" | "SLIPPAGE_EXCEEDED";
export type ExecutionErrorCode = "IMMUTABLE_TRADE_ERROR" | "INVALID_TRANSITION" | "CANDLE_NOT_CLOSED";
export type TradeEventType = "TRADE_CREATED" | "TRADE_OPENED" | "TRADE_PARTIAL" | "TRADE_CLOSED" | "TRADE_REJECTED";

import type { MarketContextSnapshot } from "../signal/context";

export interface SignalSource {
  bias: string;
  location: string;
  trigger: string;
  reactionQuality: string;
  emaContext: string;
}

export interface TradeSnapshot {
  readonly tradeId: string;
  readonly symbol: string;
  readonly direction: TradeDirection;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly lot: number;
  readonly riskUSD: number;
  readonly signalSource: Readonly<SignalSource>;
  readonly decisionTrace: readonly string[];
  readonly createdAt: number;
  readonly executionMode: "PAPER";
  /** Forwarded from TradePlan.marketContext; audit metadata only. */
  readonly marketContext?: MarketContextSnapshot;
}

export interface FillSimulation {
  /** Price units added against the trader (BUY pays up, SELL sells down). */
  spread: number;
  /** Requested slippage in price units, always adverse. */
  slippage: number;
  maxSlippage: number;
  latencyMs: number;
  /** Adverse drift per ms of latency in price units (0 = none). */
  latencyDriftPerMs: number;
}

export interface FillResult {
  marketPrice: number;
  actualEntry: number;
  spreadApplied: number;
  slippageApplied: number;
  latencyDrift: number;
}

export interface ContractValue { tickSize: number; tickValue: number }

export interface TradeResult {
  readonly tradeId: string;
  readonly entry: number;
  readonly exit: number;
  readonly profitLossUSD: number;
  readonly profitLossPercent: number;
  readonly closeReason: CloseReason;
  readonly durationSeconds: number;
}

export interface PaperTrade {
  readonly id: string;
  readonly state: ExecutionState;
  readonly snapshot: TradeSnapshot;
  readonly fill: Readonly<FillResult>;
  readonly contract: Readonly<ContractValue>;
  readonly accountEquity: number;
  readonly openedAt: number | null;
  readonly closedAt: number | null;
  readonly result: TradeResult | null;
  readonly audit: { readonly executionMode: "PAPER"; readonly orderSent: false; readonly brokerTouched: false };
}

export interface TradeEvent { readonly type: TradeEventType; readonly tradeId: string; readonly at: number; readonly detail?: string }

export const PAPER_EXECUTION_POLICY_VERSION = "paper-exec-m5-v1";

export const PAPER_RULES = {
  OPEN: "only M4 decision === APPROVED opens; else REJECTED RISK_NOT_APPROVED",
  FILL: "BUY: market + spread + slippage + drift; SELL: market − spread − slippage − drift; slippage > max ⇒ REJECTED",
  EXIT_BUY: "closed candle: low <= SL ⇒ SL_HIT; high >= TP ⇒ TP_HIT",
  EXIT_SELL: "closed candle: high >= SL ⇒ SL_HIT; low <= TP ⇒ TP_HIT",
  CONFLICT: "both in same candle ⇒ SL first (conservative)",
  IMMUTABLE: "entry/SL/TP/lot/riskUSD/decisionTrace frozen at creation; mutation ⇒ IMMUTABLE_TRADE_ERROR",
  TRANSITIONS: "IDLE→PENDING|REJECTED; PENDING→OPEN|REJECTED; OPEN→PARTIAL|CLOSED; PARTIAL→CLOSED",
} as const;
