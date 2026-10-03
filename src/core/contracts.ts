// Stage 0 contracts mirrored on the frontend. The frontend is a VIEW of
// backend state: it never derives signals or holds execution capability.

export type OperatingMode = "MONITOR_ONLY" | "DEMO" | "LIVE";

// Stage 2: hard-coded. There is intentionally no execution module, no order
// endpoint and no order types in this codebase.
export const OPERATING_MODE: OperatingMode = "MONITOR_ONLY";
export const EXECUTION_ENABLED = false as const;

export type Timeframe = "M5" | "M15" | "H1" | "H4";
export type EvidenceSource = "BROKER" | "TECHNICAL" | "USER" | "EXTERNAL" | "AI_INTERPRETATION";
export type HealthState = "HEALTHY" | "DEGRADED" | "DOWN" | "NOT_BUILT";

/** Canonical market event — normalized from broker raw data. */
export interface MarketEvent {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  brokerTime: number; // broker timestamp (ms)
  receivedAt: number; // canonical clock (ms, UTC)
  source: "MOCK" | "EXNESS_MT5";
}

/** Evidence ≠ Decision: describes state, never BUY/SELL. */
export interface EvidenceState {
  id: string;
  source: EvidenceSource;
  key: string;
  timeframe?: Timeframe;
  value: string;
  asOf: number;
}

export interface ModuleHealth {
  name: string;
  state: HealthState;
  note: string;
}
