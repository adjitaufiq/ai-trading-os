// Stage 3.0B-1 — versioned READ-ONLY bridge contracts.
// No execution surface exists here: only SYSTEM / DISCOVERY / MARKET_DATA.
// Synthetic values used with these contracts are NOT Exness characteristics.
import type { Timeframe } from "../../contracts";

export const BRIDGE_SCHEMA_VERSION = "3.0B-1" as const;
export type BridgeSchemaVersion = typeof BRIDGE_SCHEMA_VERSION;

export type BridgeSource = "EXNESS_MT5";
export type BridgeSourceMode = "SIMULATION" | "REAL";
export type BridgeDelivery = "LIVE" | "BACKFILL";

// ---------- Capability whitelist ----------
export type BridgeCapabilityGroup = "SYSTEM" | "DISCOVERY" | "MARKET_DATA";
export const READ_ONLY_CAPABILITIES = Object.freeze([
  "SYSTEM.HEALTH",
  "SYSTEM.TERMINAL_INFO",
  "SYSTEM.CLOCK_PROBE",
  "DISCOVERY.SYMBOLS",
  "DISCOVERY.RESOLVE_SYMBOL",
  "DISCOVERY.SYMBOL_SPEC",
  "MARKET_DATA.TICKS",
  "MARKET_DATA.BARS",
] as const);
export type BridgeCapability = (typeof READ_ONLY_CAPABILITIES)[number];
export const ALLOWED_CAPABILITY_GROUPS: readonly BridgeCapabilityGroup[] = Object.freeze(["SYSTEM", "DISCOVERY", "MARKET_DATA"]);

// ---------- Errors ----------
/** Public wire shape of an MT5 last_error(). Raw tuple is internal-only provenance. */
export interface Mt5Error {
  readonly code: number;
  readonly description: string;
}
export type BridgeErrorKind = "MT5_ERROR" | "CAPABILITY_DENIED" | "INVALID_REQUEST" | "NOT_FOUND";
export interface BridgeError {
  readonly kind: BridgeErrorKind;
  readonly message: string;
  readonly mt5_error: Mt5Error | null;
}

// ---------- Timing / latency (never a generic latency_ms) ----------
/** Bridge-clock timestamps and client-clock timestamps are NOT the same clock. */
export interface BridgeTiming {
  /** Source event time (raw, broker clock) when the payload has one; else null. */
  readonly source_event_at: number | null;
  /** Bridge (VPS) clock. */
  readonly bridge_received_at: number;
  readonly bridge_sent_at: number;
  /** Client clock. */
  readonly client_sent_at: number;
  readonly client_received_at: number;
}
export interface LatencyDecomposition {
  /** bridge_received − source_event. Contaminated by broker/VPS clock offset. */
  readonly source_arrival_delay_observed_ms: number | null;
  /** bridge_sent − bridge_received (same clock). */
  readonly bridge_processing_ms: number;
  /** client_received − bridge_sent. ONE-WAY APPARENT, contaminated by VPS/client offset. NOT RTT. */
  readonly bridge_to_client_apparent_delay_ms: number;
  /** client_received − client_sent (same clock, requester side). */
  readonly transport_rtt_ms: number;
}

// ---------- Envelope ----------
interface EnvelopeBase {
  readonly schema_version: BridgeSchemaVersion;
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly request_id: string;
  /** Strictly increasing per bridge instance, across epochs. */
  readonly sequence: number;
  readonly delivery: BridgeDelivery;
  readonly source: BridgeSource;
  readonly source_mode: BridgeSourceMode;
  readonly capability: BridgeCapability;
  readonly timing: BridgeTiming;
  readonly latency: LatencyDecomposition;
}
export type BridgeEnvelope<T> =
  | (EnvelopeBase & { readonly ok: true; readonly data: T; readonly error: null })
  | (EnvelopeBase & { readonly ok: false; readonly data: null; readonly error: BridgeError });

// ---------- SYSTEM ----------
export interface BridgeHealth {
  readonly bridge_instance_id: string;
  readonly connection_epoch: number;
  readonly source_mode: BridgeSourceMode;
  readonly terminal_connected: boolean;
}
/** terminal_info() observation. Observed flags carry NO execution authority. */
export interface TerminalInfoObservation {
  readonly connected: boolean;
  /** Raw ping_last, MICROSECONDS. */
  readonly terminal_ping_us: number;
  /** Derived: terminal_ping_us / 1000. */
  readonly terminal_ping_ms: number;
  readonly retransmission: number;
  readonly trade_allowed_observed: boolean;
  readonly tradeapi_disabled_observed: boolean;
  readonly authority: "OBSERVATION_ONLY";
}
/** NTP-style offset estimate between client clock and bridge clock. */
export interface ClockOffsetObservation {
  readonly client_sent_at: number;
  readonly bridge_at: number;
  readonly client_received_at: number;
  readonly rtt_ms: number;
  /** bridge − client midpoint; ± rtt/2 uncertainty. */
  readonly offset_estimate_ms: number;
  readonly uncertainty_ms: number;
}

// ---------- DISCOVERY ----------
export interface BridgeSymbolInfo {
  readonly broker_symbol: string;
  readonly description: string;
  readonly path: string;
  readonly currency_base: string;
  readonly currency_profit: string;
  readonly digits: number;
  readonly point: number;
  readonly trade_contract_size: number;
}
export type SymbolResolutionStatus = "RESOLVED" | "UNRESOLVED";
export type SymbolResolutionReason = "UNIQUE_METADATA_MATCH" | "USER_PINNED" | "AMBIGUOUS" | "NO_CANDIDATE" | "PIN_NOT_IN_CANDIDATES" | "DISCOVERY_ERROR";
export interface SymbolResolution {
  readonly canonical: string;
  readonly group_filter: string;
  readonly status: SymbolResolutionStatus;
  readonly broker_symbol: string | null;
  readonly reason: SymbolResolutionReason;
  /** All filter hits, before metadata inspection. */
  readonly candidates: readonly string[];
  /** Hits that survive metadata inspection. */
  readonly metadata_matches: readonly string[];
}

// ---------- MARKET DATA (raw timestamps preserved, precision per kind) ----------
export interface BridgeTick {
  readonly broker_symbol: string;
  /** Raw broker-clock seconds as reported. */
  readonly raw_time_s: number;
  /** Raw broker-clock milliseconds as reported (tick precision). */
  readonly raw_time_msc: number;
  readonly time_precision: "ms";
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly volume: number;
  readonly flags: number;
}
export interface BridgeBar {
  readonly broker_symbol: string;
  readonly timeframe: Timeframe;
  /** Raw broker-clock open time in seconds (bar precision — no ms invented). */
  readonly raw_time_s: number;
  readonly time_precision: "s";
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tick_volume: number;
  readonly spread: number;
  readonly real_volume: number;
}

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "EMPTY" | "UNKNOWN";
export interface HistoryCoverage {
  readonly requested_from: number;
  readonly requested_to: number;
  readonly returned_count: number;
  readonly oldest_returned_at: number | null;
  readonly newest_returned_at: number | null;
  readonly coverage_status: CoverageStatus;
  readonly reason?: string;
}
export interface HistoryResult<T> {
  readonly items: readonly T[];
  readonly coverage: HistoryCoverage;
}

// ---------- Read-only endpoint interface ----------
export interface ReadOnlyBridgeClient {
  readonly capabilities: readonly BridgeCapability[];
  health(): BridgeEnvelope<BridgeHealth>;
  terminalInfo(): BridgeEnvelope<TerminalInfoObservation>;
  clockProbe(): BridgeEnvelope<ClockOffsetObservation>;
  symbols(group: string): BridgeEnvelope<readonly BridgeSymbolInfo[]>;
  resolveSymbol(canonical: string, group: string, pinned?: string): BridgeEnvelope<SymbolResolution>;
  ticks(brokerSymbol: string, fromS: number, toS: number, delivery?: BridgeDelivery): BridgeEnvelope<HistoryResult<BridgeTick>>;
  bars(brokerSymbol: string, timeframe: Timeframe, fromS: number, toS: number, delivery?: BridgeDelivery): BridgeEnvelope<HistoryResult<BridgeBar>>;
  /** Generic dispatcher guarded by the whitelist. */
  invoke(capability: string): BridgeEnvelope<unknown>;
}
