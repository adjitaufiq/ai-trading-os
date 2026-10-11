// Phase 6A / Stage 10 DEMO — Demo Stress Test execution contracts.
// DEMO ONLY: there is no type, mode or code path that targets a real account.
import type { BrokerSymbolInfo } from "../../../engine/risk/types";

export type ExecutionMode = "REAL_DISABLED" | "PAPER_ONLY" | "DEMO_STRESS_TEST";
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "REAL_DISABLED";
export const DEMO_EXECUTION_POLICY_VERSION = "demo-exec-v1" as const;

/** Initial demo stress-test risk profile (operator-chosen; collect execution data, not optimise profit). */
export const DEMO_RISK_PROFILE = Object.freeze({
  riskPercent: 0.5,
  maxOpenPositions: 1,
  maxTradesPerDay: 5,
  maxDailyLossPercent: 2,
});
export type DemoRiskProfile = typeof DEMO_RISK_PROFILE;

export function parseExecutionMode(v: string | undefined | null): ExecutionMode {
  return v === "PAPER_ONLY" || v === "DEMO_STRESS_TEST" ? v : "REAL_DISABLED";
}

export type AccountTradeMode = "DEMO" | "CONTEST" | "REAL" | "UNKNOWN";
export interface DemoAccountIdentity {
  readonly login: number; readonly server: string; readonly tradeMode: AccountTradeMode;
  readonly balance: number; readonly equity: number; readonly currency: string;
}
export interface DemoWhitelist { readonly logins: readonly number[]; readonly servers: readonly string[] }

export type AccountBlockReason = "IDENTITY_UNAVAILABLE" | "ACCOUNT_NOT_DEMO" | "ACCOUNT_NOT_WHITELISTED" | "SERVER_NOT_WHITELISTED";
export type SafetyBlockReason = "MODE_NOT_DEMO" | "KILL_SWITCH" | "DUPLICATE_SIGNAL" | "MAX_OPEN_POSITIONS" | "MAX_DAILY_TRADES" | "DAILY_LOSS_LIMIT";
export type SizingBlockReason = "SYMBOL_INFO_UNAVAILABLE" | "LOT_BELOW_MINIMUM" | "INVALID_PLAN" | "BLOCK_COUNTER_PRIMARY_BIAS";
export type BlockReason = AccountBlockReason | SafetyBlockReason | SizingBlockReason;

/** Engine context frozen at the approved signal (copied from Engine Host, never computed here). */
export interface DemoEntryContext {
  readonly regime: string | null; readonly h4Bias: string | null; readonly h1State: string | null;
  readonly setup: string | null; readonly decision: string | null; readonly confidence: number | null;
  /** v0.5 technical slice primary_bias (closed-H4 structure+EMA): BUY | SELL | NONE. */
  readonly primaryBias?: string | null;
  readonly counterTrendCondition?: string | null;
  readonly reasons: readonly string[]; readonly signalSource: Readonly<Record<string, string>>;
  readonly engineSnapshot: unknown;
}

export interface DemoOrderIntent {
  readonly signalId: string; readonly planId: string; readonly symbol: string; readonly direction: "BUY" | "SELL";
  readonly plannedEntry: number; readonly stopLoss: number; readonly takeProfit: number; readonly rr: number | null;
  readonly closedBarAt: number; readonly context: DemoEntryContext;
}

export interface DemoOrderRequest {
  readonly signalId: string; readonly symbol: string; readonly direction: "BUY" | "SELL";
  readonly volume: number; readonly stopLoss: number; readonly takeProfit: number;
}
export interface DemoOrderResponse {
  readonly status: "FILLED" | "REJECTED" | "ERROR";
  readonly ticket: number | null; readonly price: number | null; readonly retcode: number | null; readonly comment: string;
}
export interface DemoPosition { readonly ticket: number; readonly symbol: string; readonly comment: string }
export interface DemoCloseDeal {
  readonly positionTicket: number; readonly price: number; readonly profit: number; readonly time: number;
  readonly reason: "SL" | "TP" | "OTHER";
}

/** Typed client of the loopback demo execution gateway (VPS). */
export interface DemoExecGatewayPort {
  account(): Promise<DemoAccountIdentity | null>;
  symbol(symbol: string): Promise<BrokerSymbolInfo | null>;
  positions(): Promise<readonly DemoPosition[]>;
  closeDeal(positionTicket: number): Promise<DemoCloseDeal | null>;
  sendOrder(req: DemoOrderRequest): Promise<DemoOrderResponse>;
}

export type DemoEventType = "DAY_START" | "BLOCKED" | "SEND_ATTEMPT" | "FILLED" | "REJECTED" | "ERROR" | "CLOSED";
export interface DemoEvent {
  readonly type: DemoEventType; readonly at: number; readonly signalId: string | null; readonly symbol: string | null;
  readonly detail?: string; readonly data?: Readonly<Record<string, unknown>>;
}

/** One journal record per demo order (derived from the append-only event log). */
export interface DemoTradeRecord {
  readonly tradeId: string; readonly signalId: string; readonly symbol: string; readonly direction: "BUY" | "SELL";
  readonly sentAt: number; readonly volume: number; readonly riskUSD: number;
  readonly plannedEntry: number; readonly actualEntry: number | null; readonly slippage: number | null; readonly latencyMs: number | null;
  readonly stopLoss: number; readonly takeProfit: number; readonly ticket: number | null;
  readonly executionResult: "FILLED" | "REJECTED" | "ERROR" | "PENDING";
  readonly executionDetail: string;
  readonly exitPrice: number | null; readonly exitReason: "SL" | "TP" | "OTHER" | null; readonly closedAt: number | null;
  readonly profitLossUSD: number | null; readonly outcome: "WIN" | "LOSS" | "BREAKEVEN" | null;
  readonly context: DemoEntryContext;
}

export interface DemoLabStatus {
  readonly mode: ExecutionMode; readonly policyVersion: typeof DEMO_EXECUTION_POLICY_VERSION; readonly profile: DemoRiskProfile;
  readonly killSwitch: boolean; readonly account: { readonly ok: boolean; readonly reason: AccountBlockReason | null; readonly login: number | null; readonly server: string | null; readonly tradeMode: AccountTradeMode | null };
  readonly openPositions: number; readonly tradesToday: number; readonly dailyLossPercent: number;
  /** Demo capital since the first recorded day: broker balance/equity copied as-is, netPnl = equity − startBalance. */
  readonly capital?: { readonly startBalance: number | null; readonly balance: number | null; readonly equity: number | null; readonly currency: string | null; readonly netPnl: number | null };
  readonly lastEvent: DemoEvent | null; readonly records: readonly DemoTradeRecord[]; readonly recentEvents: readonly DemoEvent[];
}
