// M3 — Trade plan engine contracts.
// Converts a READY SignalSetup (M2) + confirmed M15 structure (M1B.3) into an
// objective TradePlan. No lot sizing, no broker access, no execution, no
// running candles, no new swings, no H1/H4 for scalp SL, SL never moved for RR.

export type PlanStatus = "PLANNED" | "HOLD";

export type HoldReason =
  | "SETUP_NOT_READY"
  | "INVALID_DIRECTION"
  | "INVALID_INPUT"
  | "NOT_M15_STRUCTURE"
  | "NO_SL_ANCHOR"
  | "SL_TOO_WIDE"
  | "NO_TP_TARGET"
  | "BAD_RR";

export type SlSource = "M15_SR_INVALIDATION" | "M15_CONFIRMED_SWING";
export type TpSource = "M15_NEAREST_RESISTANCE" | "M15_NEAREST_SUPPORT";

export interface SlResult { ok: true; sl: number; anchor: number; source: SlSource; distance: number }
export interface TpResult { ok: true; tp: number; target: number; source: TpSource }
export type SlCalc = SlResult | { ok: false; reason: "NO_SL_ANCHOR" | "SL_TOO_WIDE"; anchor?: number; distance?: number };
export type TpCalc = TpResult | { ok: false; reason: "NO_TP_TARGET" };

export interface PlanCheck { name: string; result: "PASS" | "FAIL" | "SKIP"; detail?: string }

export interface TradePlan {
  id: string;
  signalId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  status: PlanStatus;
  holdReason?: HoldReason;
  entry: number;
  sl: number | null;
  tp: number | null;
  riskDistance: number | null;
  rewardDistance: number | null;
  rr: number | null;
  slSource: SlSource | null;
  tpSource: TpSource | null;
  atrM15: number;
  createdAt: number;
  policyVersion: string;
  /** Audit semantics: plan is a reference object, never an order. */
  audit: { executable: false; orderSent: false; lotCalculated: false; mode: "PLAN_ONLY" };
  trace: PlanCheck[];
}

export const PLAN_POLICY_VERSION = "plan-m3-v1";

export const PLAN_PARAMS = {
  SL_ATR_BUFFER: 0.25,
  MAX_SL_ATR: 2.5,
  TP_ATR_BUFFER: 0.1,
  MIN_RR: 1.2,
} as const;

export const PLAN_RULES = {
  INPUT: "setup.state must be READY; direction BUY/SELL; ATR(M15) > 0; structure timeframe M15",
  SL_PRIORITY: ["M15 S/R invalidation level (setup.keyLevel)", "latest confirmed M15 swing (confirmedAt <= now)"],
  SL_BUY: "anchor < entry; SL = anchor - 0.25*ATR",
  SL_SELL: "anchor > entry; SL = anchor + 0.25*ATR",
  SL_TOO_WIDE: "|entry - SL| > 2.5*ATR ⇒ HOLD SL_TOO_WIDE (SL never tightened)",
  TP_BUY: "nearest confirmed M15 swing high above entry; TP = level - 0.1*ATR, must stay > entry",
  TP_SELL: "nearest confirmed M15 swing low below entry; TP = level + 0.1*ATR, must stay < entry",
  RR: "rr = reward/risk; rr < 1.2 ⇒ HOLD BAD_RR (SL/TP never adjusted to pass)",
  FORBIDDEN: "no running candles, no new swings, no H1/H4 SL, no lot, no broker",
} as const;
