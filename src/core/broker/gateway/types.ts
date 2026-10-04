// Stage 3.0B-2C — App-side gateway client contracts.
// Reuses the FROZEN 3.0B-1 bridge contract. The only wire-level difference is
// nullability the 2B gateway emits honestly (client-clock fields it cannot
// observe, coverage bounds for count-based modes). Those are expressed as
// derived types over the frozen ones — not a second contract.
import type {
  BridgeBar,
  BridgeCapability,
  BridgeDelivery,
  BridgeError,
  BridgeHealth,
  BridgeSchemaVersion,
  BridgeSource,
  BridgeSourceMode,
  BridgeSymbolInfo,
  BridgeTick,
  BridgeTiming,
  HistoryCoverage,
  LatencyDecomposition,
  TerminalInfoObservation,
} from "../bridge/types";
import type { Timeframe } from "../../contracts";

// ---------- Wire envelope (frozen field names; bridge-unobservable fields nullable) ----------
export type WireBridgeTiming = Omit<BridgeTiming, "client_sent_at" | "client_received_at"> & {
  readonly client_sent_at: null;
  readonly client_received_at: null;
};
export type WireLatency = Omit<LatencyDecomposition, "bridge_to_client_apparent_delay_ms" | "transport_rtt_ms"> & {
  readonly source_arrival_delay_observed_ms: number | null;
  readonly bridge_to_client_apparent_delay_ms: null;
  readonly transport_rtt_ms: null;
};
interface WireEnvelopeBase {
  readonly schema_version: BridgeSchemaVersion;
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly request_id: string;
  readonly sequence: number;
  readonly delivery: BridgeDelivery;
  readonly source: BridgeSource;
  readonly source_mode: BridgeSourceMode;
  readonly capability: BridgeCapability;
  readonly timing: WireBridgeTiming;
  readonly latency: WireLatency;
}
export type WireEnvelope<T> =
  | (WireEnvelopeBase & { readonly ok: true; readonly data: T; readonly error: null })
  | (WireEnvelopeBase & { readonly ok: false; readonly data: null; readonly error: BridgeError });

export type WireHistoryCoverage = Omit<HistoryCoverage, "requested_from" | "requested_to" | "reason"> & {
  readonly requested_from: number | null;
  readonly requested_to: number | null;
  readonly reason: string | null;
};
export interface WireHistoryResult<T> {
  readonly items: readonly T[];
  readonly coverage: WireHistoryCoverage;
}

export type { BridgeBar, BridgeHealth, BridgeSymbolInfo, BridgeTick, TerminalInfoObservation };

// ---------- Requests (typed; mapped to approved 2B routes only) ----------
/** UTC instant. Must be timezone-explicit; serialized as ISO-8601 with Z. */
export type UtcMs = number;
export type TickHistoryRequest =
  | { readonly symbol: string; readonly mode: "range"; readonly from: UtcMs; readonly to: UtcMs }
  | { readonly symbol: string; readonly mode: "from"; readonly from: UtcMs; readonly count: number };
export type BarHistoryRequest =
  | { readonly symbol: string; readonly timeframe: Timeframe; readonly mode: "range"; readonly from: UtcMs; readonly to: UtcMs }
  | { readonly symbol: string; readonly timeframe: Timeframe; readonly mode: "from"; readonly from: UtcMs; readonly count: number }
  | { readonly symbol: string; readonly timeframe: Timeframe; readonly mode: "pos"; readonly start: number; readonly count: number };
export interface MarketDataSubscription {
  readonly stream: "ticks";
  readonly symbols: readonly string[];
}

// ---------- Client timing (client clock domain only) ----------
export interface ClientTiming {
  /** Client wall clock (CanonicalClock). null for unsolicited WS events. */
  readonly client_sent_at: number | null;
  readonly client_received_at: number;
  /** Client monotonic clock readings (durations only). */
  readonly client_sent_mono: number | null;
  readonly client_received_mono: number;
  /** client_received_mono − client_sent_mono. null when no 1:1 request exists. */
  readonly transport_rtt_ms: number | null;
  /** client_received_at − bridge_sent_at. CROSS-DOMAIN (VPS vs client clock), apparent only, NOT network latency. */
  readonly bridge_to_client_apparent_delay_ms: number | null;
}

// ---------- Errors ----------
export type ClientErrorKind =
  | "TRANSPORT_ERROR"
  | "TIMEOUT"
  | "HTTP_PROTOCOL_ERROR"
  | "CLIENT_PROTOCOL_ERROR"
  | "GATEWAY_ERROR"
  | "MT5_ERROR"
  | "NOT_FOUND"
  | "INVALID_REQUEST";
export interface EnvelopeRef {
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly request_id: string;
  readonly sequence: number;
}
export interface ClientError {
  readonly kind: ClientErrorKind;
  /** Sanitized message; never a stack trace. */
  readonly message: string;
  readonly http_status: number | null;
  /** Frozen BridgeError when the gateway produced a valid error envelope. */
  readonly bridge_error: BridgeError | null;
  readonly envelope: EnvelopeRef | null;
  readonly timing: ClientTiming | null;
}

// ---------- Sequence observations ----------
export type SequenceObservationKind =
  | "SEQUENCE_DUPLICATE"
  | "SEQUENCE_REGRESSION"
  | "SEQUENCE_GAP"
  | "BRIDGE_INSTANCE_CHANGE"
  | "EPOCH_REGRESSION"
  | "EPOCH_ADVANCE";
export interface SequenceObservation {
  readonly kind: SequenceObservationKind;
  readonly channel: "HTTP" | "STREAM";
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly sequence: number;
  readonly previous: { readonly bridge_instance_id: string; readonly connection_epoch: number; readonly sequence: number } | null;
  readonly missing?: number;
}
/** ACCEPT = tracker state advanced; QUARANTINE = not advanced, must not be ingested. */
export type SequenceDisposition = "ACCEPT" | "ACCEPT_WITH_FLAG" | "QUARANTINE";

// ---------- Results ----------
export interface GatewayOk<T> {
  readonly ok: true;
  readonly data: T;
  readonly envelope: WireEnvelope<T>;
  readonly timing: ClientTiming;
  readonly sequence: { readonly disposition: SequenceDisposition; readonly observations: readonly SequenceObservation[] };
}
export interface GatewayFail {
  readonly ok: false;
  readonly error: ClientError;
  readonly sequence: { readonly disposition: SequenceDisposition; readonly observations: readonly SequenceObservation[] } | null;
}
export type GatewayResult<T> = GatewayOk<T> | GatewayFail;

/** Full traceability for one tick observed through the gateway. Nothing dropped. */
export interface ClientTickObservation {
  readonly raw_event_id: string;
  readonly tick: BridgeTick;
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly request_id: string;
  readonly sequence: number;
  readonly item_index: number;
  readonly source: BridgeSource;
  readonly source_mode: BridgeSourceMode;
  readonly delivery: BridgeDelivery;
  readonly bridge_timing: WireBridgeTiming;
  readonly bridge_latency: WireLatency;
  readonly client_timing: ClientTiming;
  readonly sequence_disposition: SequenceDisposition;
  readonly sequence_observations: readonly SequenceObservation[];
}

// ---------- Health ----------
export type HealthStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
export type FreshnessStatus = "FRESH" | "STALE" | "UNKNOWN";
export type ExecutionCapability = "ABSENT" | "AVAILABLE";
export type ExecutionAuthorization = "DISABLED" | "AUTHORIZED";
export interface GatewayHealthState {
  readonly transport_health: HealthStatus;
  readonly gateway_health: HealthStatus;
  readonly terminal_health: HealthStatus;
  readonly market_data_freshness: FreshnessStatus;
  /** Age since the client last RECEIVED a LIVE tick (client monotonic clock). Not source age. */
  readonly last_tick_age_ms: number | null;
  readonly system_status: HealthStatus;
  readonly execution_capability: ExecutionCapability;
  readonly execution_authorization: ExecutionAuthorization;
  /** Observed from envelopes; null until a valid envelope arrives. */
  readonly source_mode: BridgeSourceMode | null;
}
