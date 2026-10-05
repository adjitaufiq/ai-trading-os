// Stage 3.0A — broker domain contracts. Raw provenance is first-class.
// Values in synthetic fixtures are NOT real Exness characteristics.
import type { MarketEvent, Timeframe } from "../contracts";

export type BrokerSource = "EXNESS_MT5";
export type SpecOrigin = "SYNTHETIC" | "BROKER_REPORTED";
export type DeliveryKind = "STREAM" | "BACKFILL";

/** Raw tick exactly as a broker bridge would hand it over (broker server time). */
export interface RawBrokerTick {
  readonly raw_event_id: string;
  readonly symbol: string;
  readonly broker_time_ms: number;
  readonly bid: number;
  readonly ask: number;
  readonly last?: number;
  readonly volume?: number;
  readonly flags?: number;
}

/** Raw bar as reported by the broker (open time in broker server time). */
export interface RawBrokerBar {
  readonly raw_event_id: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly open_time_broker_ms: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tick_volume: number;
  readonly real_volume: number | null;
  readonly spread?: number;
}

/** Transport wrapper. The raw payload is preserved untouched. */
export interface BrokerEventEnvelope<T = RawBrokerTick> {
  readonly raw: T;
  readonly source: BrokerSource;
  readonly symbol: string;
  /** UTC ms when the bridge received the payload (becomes observed_at). */
  readonly received_at: number;
  readonly connection_epoch: number;
  readonly delivery: DeliveryKind;
}

export interface SymbolSpecification {
  readonly symbol: string;
  readonly origin: SpecOrigin;
  readonly digits: number;
  readonly point: number;
  readonly tick_size: number;
  readonly contract_size: number;
  /** broker_time - UTC. Assumption until TRS-03 measures it. */
  readonly broker_utc_offset_ms: number;
}

export type ConnectionStatus = "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "RECONNECTING";
export interface BrokerConnectionState {
  readonly mode: "SIMULATION" | "REAL";
  readonly status: ConnectionStatus;
  readonly epoch: number;
  readonly since: number | null;
  readonly note: string;
}

/** Traceability for every normalized event. */
export interface Provenance {
  readonly raw_event_id: string;
  readonly source: BrokerSource;
  readonly symbol: string;
  readonly received_at: number;
  readonly normalizer_version: string;
  readonly connection_epoch: number;
  readonly delivery: DeliveryKind;
}

export interface BrokerMarketEvent extends MarketEvent {
  readonly provenance: Provenance;
}

export interface NormalizedBrokerBar {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly open_time: number; // UTC
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tick_volume: number;
  readonly real_volume: number | null;
  /** UTC ms the bar was received from the broker (closure observation). */
  readonly observed_at: number;
  readonly provenance: Provenance;
}

export type AnomalyClassification =
  | "TEMPORAL_INVALID"
  | "LATE_EVENT"
  | "DUPLICATE"
  | "AMBIGUOUS_COLLISION"
  | "OUT_OF_ORDER"
  | "GAP"
  | "RECONNECT_BACKFILL"
  | "SOURCE_CLOCK_SKEW";

export type AnomalyDisposition = "ACCEPT" | "ACCEPT_WITH_FLAG" | "QUARANTINE" | "RECONCILE" | "REJECT";

/** One observation. An event may carry several; classification ≠ disposition. */
export interface FeedAnomaly {
  readonly classification: AnomalyClassification;
  readonly disposition: AnomalyDisposition;
  readonly raw_event_id: string;
  readonly detail: string;
}

export type DiscrepancyOutcome = "EXACT" | "WITHIN_TOLERANCE" | "MISMATCH" | "INSUFFICIENT_DATA" | "NOT_COMPARABLE";

export interface DiscrepancyMetrics {
  open_delta_price: number;
  high_delta_price: number;
  low_delta_price: number;
  close_delta_price: number;
  open_delta_points: number;
  high_delta_points: number;
  low_delta_points: number;
  close_delta_points: number;
  tick_volume_delta: number;
  real_volume_delta: number | null;
  open_time_delta_ms: number;
  closure_observation_delta_ms: number | null;
}

export interface DiscrepancyResult {
  readonly outcome: DiscrepancyOutcome;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly open_time: number | null;
  readonly reason: string;
  readonly metrics: DiscrepancyMetrics | null;
}
