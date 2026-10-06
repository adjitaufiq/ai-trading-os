// M2 — Signal lifecycle engine & setup state machine contracts.
// Consumes ONLY validated M1B outputs (bias M1B.4, location M1B.5, EMA M1B.6,
// reaction M1B.7). Never recalculates indicators. No SL/TP/lot/execution.
import type { InstitutionalFootprints } from "../core/market/institutional-radar/types";
import type { MarketContextSnapshot } from "./context";

export type SignalDirection = "BUY" | "SELL" | "NONE";

export type SignalState =
  | "RADAR_AREA"
  | "WAITING_REACTION"
  | "REACTION_CONFIRMED"
  | "READY"
  | "INVALIDATED"
  | "EXPIRED";

export type InvalidationReason =
  | "LOCATION_BROKEN"
  | "STRUCTURE_SHIFT"
  | "EMA_CONTEXT_FAILED"
  | "REACTION_FAILED"
  | "TTL_EXPIRED"
  | "MANUAL_CANCEL";

export interface SignalSetup {
  id: string;
  symbol: string;
  direction: SignalDirection;
  state: SignalState;
  createdAt: number;
  updatedAt: number;
  location: string;
  keyLevel: number;
  triggerPattern: string;
  reactionQuality: "NONE" | "WEAK" | "MODERATE" | "STRONG";
  biasContext: string;
  invalidationReason?: InvalidationReason;
  expiryTimestamp: number;
  /** Anti-chase anchor (P0.4): price at setup creation, frozen. */
  snapshotPrice: number;
  /** Detail for EXPIRED: TTL ran out vs price chased beyond tolerance. */
  expiredBy?: "TTL" | "PRICE_CHASED";
  /** M1B.8 passive evidence; OPTIONAL, never read by state machine or entry rules. */
  footprints?: InstitutionalFootprints;
  /** m2-context-v1 observational envelope (M1B.8–11); OPTIONAL, never read by lifecycle. */
  readonly marketContext?: MarketContextSnapshot;
}

export type CheckResult = "PASS" | "FAIL" | "SKIP";
export interface DecisionCheck { name: string; result: CheckResult; detail?: string }
export interface DecisionTrace { state: SignalState | "NO_SETUP"; checks: DecisionCheck[]; at: number }

export type NoSetupReason =
  | "MID_RANGE"
  | "NO_M5_REACTION"
  | "WRONG_LOCATION"
  | "DATA_STALE"
  | "CANDLE_NOT_CLOSED"
  | "STRUCTURE_INVALID";

export type SetupEvaluation =
  | { kind: "NO_SETUP"; reason: NoSetupReason; trace: DecisionTrace }
  | { kind: "CANDIDATE"; direction: "BUY" | "SELL"; state: "RADAR_AREA" | "WAITING_REACTION" | "REACTION_CONFIRMED" | "READY"; trace: DecisionTrace };

export const SIGNAL_POLICY_VERSION = "signal-m2-v1";

export const SIGNAL_PARAMS = {
  /** TTL: setup valid for this many M5 bars starting at the creation bar. */
  SIGNAL_TTL_M5_BARS: 3,
  M5_SECONDS: 300,
  /** Anti-chase: |price − snapshotPrice| > this × ATR(M15) ⇒ EXPIRED. */
  MAX_CHASE_ATR_MULT: 0.5,
  /** RADAR: MID_RANGE price within this × ATR(M15) of the nearest level. */
  RADAR_ATR_MULT: 1.0,
} as const;

export const SIGNAL_RULES = {
  DIRECTION: "AT_SUPPORT/near SUPPORT ⇒ BUY; AT_RESISTANCE/near RESISTANCE ⇒ SELL",
  RADAR_AREA: "MID_RANGE AND distanceToLevel <= 1.0*ATR(M15); otherwise NO_SETUP(MID_RANGE)",
  WAITING_REACTION: "AT_SUPPORT/AT_RESISTANCE AND no valid (MODERATE/STRONG) M5 reaction in the setup direction",
  REACTION_CONFIRMED: "valid M5 reaction in direction, but bias or EMA filter fails",
  READY: "location valid + valid M5 reaction + bias acceptable (BUY: not BEARISH; SELL: not BULLISH) + EMA acceptable",
  EMA_ACCEPTABLE: "BUY: no EMA21_REJECT_DOWN/EMA50_RESISTANCE and price not BELOW_ALL; SELL mirrored",
  CREATION: "only from REACTION_CONFIRMED/READY evaluations on a CLOSED M5 candle",
  INVALIDATION_PRIORITY: ["LOCATION_BROKEN", "STRUCTURE_SHIFT", "EMA_CONTEXT_FAILED"],
  LOCATION_BROKEN: "BUY: closed M5/M15 close < keyLevel; SELL: close > keyLevel",
  STRUCTURE_SHIFT: "BUY: M15 BEARISH_MSS; SELL: BULLISH_MSS",
  CHASE: "|price - snapshotPrice| > 0.5*ATR(M15) ⇒ EXPIRED (TTL_EXPIRED, expiredBy=PRICE_CHASED)",
  TTL: "expiry = creation bar ts + 3*300; first CLOSED M5 bar with ts >= expiry ⇒ EXPIRED",
  TERMINAL: "INVALIDATED/EXPIRED never change again",
} as const;
