// Stage 0 contracts mirrored on the frontend. The frontend is a VIEW of
// backend state: it never derives signals or holds execution capability.

export type OperatingMode = "MONITOR_ONLY" | "DEMO" | "LIVE";

// Hard-coded. There is intentionally no execution module, no order endpoint
// and no order types in this codebase.
export const OPERATING_MODE: OperatingMode = "MONITOR_ONLY";
export const EXECUTION_ENABLED = false as const;

export type Timeframe = "M5" | "M15" | "H1" | "H4";
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
};

export type EvidenceSource = "BROKER" | "TECHNICAL" | "USER" | "EXTERNAL" | "AI_INTERPRETATION";
export type HealthState = "HEALTHY" | "DEGRADED" | "DOWN" | "NOT_BUILT";
export type ClockMode = "LIVE" | "REPLAY";
export type MarketSource = "MOCK" | "REPLAY_FIXTURE" | "EXNESS_MT5";

/**
 * Canonical market event. All times are UTC epoch ms.
 * - event_at:    when the event happened at the source (broker time, normalized to UTC)
 * - observed_at: when the adapter first saw it
 * - ingested_at: when the canonical clock accepted it into the system
 * Invariant: event_at <= observed_at <= ingested_at
 */
export interface MarketEvent {
  seq: number;
  symbol: string;
  source: MarketSource;
  bid: number;
  ask: number;
  spread: number;
  event_at: number;
  observed_at: number;
  ingested_at: number;
}

export type BarStatus = "FORMING" | "CLOSED";

/**
 * Bar snapshot (immutable once emitted).
 * - open_time / close_time: mathematical interval [open_time, close_time)
 * - closed_at: when the system declared the bar CLOSED (null while FORMING).
 *   Invariant: closed_at >= close_time.
 * - effective_at: latest market time the bar's content reflects (last tick event_at).
 *   NOT automatically close_time.
 * - available_at: when the calculation finished in memory (canonical clock).
 *   A consumer at time T may only use it if T >= available_at.
 */
export interface Bar {
  symbol: string;
  timeframe: Timeframe;
  source: MarketSource;
  open_time: number;
  close_time: number;
  status: BarStatus;
  closed_at: number | null;
  effective_at: number;
  available_at: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_count: number;
  revision: number;
}

/** Evidence ≠ Decision: describes state, never BUY/SELL. */
export interface EvidenceState {
  id: string;
  source: EvidenceSource;
  key: string;
  timeframe?: Timeframe;
  value: string;
  effective_at: number;
  available_at: number;
}

export interface ModuleHealth {
  name: string;
  state: HealthState;
  note: string;
}
