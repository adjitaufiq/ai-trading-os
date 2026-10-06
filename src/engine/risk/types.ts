// M4 — Risk engine & execution guard contracts.
// EVALUATION ONLY: never modifies entry/SL/TP/RR, never sends orders.
// MONITOR_ONLY / EXECUTION_ENABLED=false stay in force; execution belongs to M5.

export type AccountMode = "CONSERVATIVE" | "STANDARD" | "AGGRESSIVE" | "CUSTOM";
export type RiskType = "PERCENTAGE" | "FIXED_USD";
export type AccountState = "NORMAL" | "RECOVERY" | "LOCKED";
export type RiskDecision = "APPROVED" | "WARNING" | "BLOCKED";
export type BlockReason =
  | "INSUFFICIENT_MARGIN"
  | "LOT_BELOW_MINIMUM"
  | "DAILY_DD_LIMIT"
  | "EXPOSURE_LIMIT"
  | "SPREAD_TOO_HIGH"
  | "COOLDOWN_ACTIVE"
  | "INVALID_RISK"
  /** Spec §9 names this reject; added to the union so it is typed. */
  | "SLIPPAGE_TOO_HIGH";

export interface AccountProfile {
  mode: AccountMode;
  state: AccountState;
  equity: number;
  peakEquity: number;
  riskType: RiskType;
  /** PERCENTAGE: percent of equity (1 = 1%). FIXED_USD: USD. */
  riskValue: number;
  maxDailyLossPercent: number;
  currentDailyDDPercent: number;
  recoveryMultiplier: number;
}

export interface BrokerSymbolInfo {
  symbol: string;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  tickSize: number;
  /** USD value of one tickSize move for 1.0 lot. */
  tickValue: number;
  marginPerLot: number;
}

export interface PositionSizeResult {
  rawLot: number;
  finalLot: number;
  riskUSD: number;
  actualRiskUSD: number;
  riskDeviationPercent: number;
  forcedMinimumLot: boolean;
}

export interface RiskRealityCheck {
  plannedBudgetUSD: number;
  actualExecutionRiskUSD: number;
  deviationPercent: number;
  isForcedByMinLot: boolean;
}

export interface RiskTraceStep { name: string; result: "PASS" | "WARN" | "FAIL" | "SKIP"; detail?: string }

export interface RiskCheckResult {
  decision: RiskDecision;
  reasons: BlockReason[];
  positionSize: PositionSizeResult | null;
  accountState: AccountState;
  reality: RiskRealityCheck | null;
  trace: RiskTraceStep[];
  policyVersion: string;
  audit: { executable: false; orderSent: false; mode: "MONITOR_ONLY" };
}

export interface OpenPositionExposure { symbol: string; riskUSD: number }
export interface ExposureLimits { maxSymbolRiskUSD: number; maxTotalRiskUSD: number }

export const RISK_POLICY_VERSION = "risk-m4-v1";

export const RISK_PARAMS = {
  RECOVERY_DRAWDOWN_PERCENT: 10,
  DEFAULT_RECOVERY_MULTIPLIER: 0.5,
  MAX_CONSECUTIVE_LOSSES: 3,
  SPREAD_SMA_PERIOD: 20,
  SPREAD_SMA_MULTIPLIER: 1.5,
  /** Hard spread caps in price units. Only XAUUSD given by spec; others RESEARCH_REQUIRED. */
  SPREAD_HARD_CAP: { XAUUSD: 0.35 } as Readonly<Record<string, number>>,
  FLOOR_EPSILON: 1e-9,
} as const;

export const RISK_RULES = {
  BUDGET: "budget = min(equity×risk% (or fixed USD) × stateMultiplier, daily loss remaining, exposure remaining)",
  STATE: "daily DD ≥ max ⇒ LOCKED; peak drawdown > 10% ⇒ RECOVERY (×recoveryMultiplier); else NORMAL",
  LOT: "rawLot = budget / ((SL distance / tickSize) × tickValue); finalLot = floor(raw/step)×step, never round",
  MIN_LOT: "finalLot < volumeMin ⇒ strict: BLOCKED LOT_BELOW_MINIMUM; non-strict: WARNING, forced volumeMin, real risk reported",
  EXPOSURE: "open risk of same symbol is clustered; symbol and total caps",
  SPREAD: "spread > SMA20×1.5 or > hard cap ⇒ BLOCKED SPREAD_TOO_HIGH; <20 samples ⇒ SMA rule skipped",
  SLIPPAGE: "|planned entry − current ASK(BUY)/BID(SELL)| > max ⇒ BLOCKED SLIPPAGE_TOO_HIGH",
  COOLDOWN: "≥3 consecutive losses today (UTC) ⇒ COOLDOWN_ACTIVE until 00:00 UTC",
  FORBIDDEN: "never modify entry/SL/TP/RR, never call broker, never send orders",
} as const;
