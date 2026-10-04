// Multi-tier health. HTTP 200 != gateway healthy != terminal healthy != data fresh != system healthy.
// Execution capability/authorization are constants of Stage 3.0B: there is no transition to change them.
import type { BridgeSourceMode } from "../bridge/types";
import type {
  BridgeHealth,
  ClientTickObservation,
  FreshnessStatus,
  GatewayHealthState,
  GatewayResult,
  HealthStatus,
  TerminalInfoObservation,
} from "./types";

export interface MonotonicClock {
  /** Monotonic milliseconds, for durations only. Never a wall-clock instant. */
  now(): number;
}

export interface FreshnessKey {
  readonly source: "EXNESS_MT5";
  readonly source_mode: BridgeSourceMode | null;
  readonly broker_symbol: string;
}
export interface FreshnessRuleResolved {
  readonly max_tick_age_ms: number;
}
/** Replaceable later by a TRS-03-derived symbol/source/session policy. */
export interface MarketDataFreshnessPolicy {
  resolve(key: FreshnessKey): FreshnessRuleResolved | null;
}
/** Default: no universal threshold exists, so freshness is UNKNOWN. */
export const NO_FRESHNESS_POLICY: MarketDataFreshnessPolicy = Object.freeze({ resolve: () => null });

/** Explicit, per-symbol configured policy. Unconfigured symbols resolve to null (UNKNOWN). */
export class ExplicitFreshnessPolicy implements MarketDataFreshnessPolicy {
  constructor(private readonly rules: Readonly<Record<string, FreshnessRuleResolved>>) {
    for (const r of Object.values(rules)) if (!(r.max_tick_age_ms > 0)) throw new Error("max_tick_age_ms must be > 0");
  }
  resolve(k: FreshnessKey): FreshnessRuleResolved | null {
    return this.rules[k.broker_symbol] ?? null;
  }
}

const EXECUTION_CAPABILITY = "ABSENT" as const;
const EXECUTION_AUTHORIZATION = "DISABLED" as const;

export function deriveSystemStatus(t: HealthStatus, g: HealthStatus, term: HealthStatus, f: FreshnessStatus): HealthStatus {
  if (t === "DOWN") return "DOWN";
  if ([t, g, term].some((s) => s === "DOWN" || s === "DEGRADED") || f === "STALE") return "DEGRADED";
  if ([t, g, term].includes("UNKNOWN") || f === "UNKNOWN") return "UNKNOWN";
  return "HEALTHY";
}

export class GatewayHealthModel {
  private transport: HealthStatus = "UNKNOWN";
  private gateway: HealthStatus = "UNKNOWN";
  private terminal: HealthStatus = "UNKNOWN";
  private sourceMode: BridgeSourceMode | null = null;
  private lastTick: { broker_symbol: string; mono: number } | null = null;

  constructor(
    private readonly mono: MonotonicClock,
    private readonly freshness: MarketDataFreshnessPolicy = NO_FRESHNESS_POLICY,
  ) {}

  private fromFailure(kind: string): void {
    if (kind === "TRANSPORT_ERROR" || kind === "TIMEOUT") {
      this.transport = "DOWN";
      this.gateway = "UNKNOWN";
      this.terminal = "UNKNOWN";
    } else {
      // Something answered: transport works, but the gateway did not give a usable health answer.
      this.transport = "HEALTHY";
      this.gateway = "DEGRADED";
      this.terminal = "UNKNOWN";
    }
  }

  recordHealthProbe(r: GatewayResult<BridgeHealth>): void {
    if (!r.ok) return this.fromFailure(r.error.kind);
    this.transport = "HEALTHY";
    this.gateway = r.sequence.disposition === "QUARANTINE" ? "DEGRADED" : "HEALTHY";
    this.terminal = r.data.terminal_connected ? "HEALTHY" : "DOWN";
    this.sourceMode = r.envelope.source_mode;
  }

  recordTerminalProbe(r: GatewayResult<TerminalInfoObservation>): void {
    if (r.ok) {
      this.transport = "HEALTHY";
      this.terminal = r.data.connected ? "HEALTHY" : "DOWN";
      this.sourceMode = r.envelope.source_mode;
      return;
    }
    if (r.error.kind === "MT5_ERROR" && r.error.bridge_error?.message === "TERMINAL_UNAVAILABLE") {
      this.transport = "HEALTHY";
      this.terminal = "DOWN";
      return;
    }
    if (r.error.kind === "TRANSPORT_ERROR" || r.error.kind === "TIMEOUT") this.fromFailure(r.error.kind);
  }

  recordStreamClosed(): void {
    // A closed stream says nothing about the gateway or terminal; it is not an authorization change.
  }

  recordTick(o: ClientTickObservation): void {
    if (o.delivery !== "LIVE" || o.sequence_disposition === "QUARANTINE") return;
    this.lastTick = { broker_symbol: o.tick.broker_symbol, mono: o.client_timing.client_received_mono };
    this.sourceMode = o.source_mode;
  }

  snapshot(): GatewayHealthState {
    const age = this.lastTick ? Math.max(0, this.mono.now() - this.lastTick.mono) : null;
    let freshness: FreshnessStatus = "UNKNOWN";
    if (this.lastTick && age !== null) {
      const rule = this.freshness.resolve({ source: "EXNESS_MT5", source_mode: this.sourceMode, broker_symbol: this.lastTick.broker_symbol });
      if (rule) freshness = age <= rule.max_tick_age_ms ? "FRESH" : "STALE";
    }
    return Object.freeze({
      transport_health: this.transport,
      gateway_health: this.gateway,
      terminal_health: this.terminal,
      market_data_freshness: freshness,
      last_tick_age_ms: age,
      system_status: deriveSystemStatus(this.transport, this.gateway, this.terminal, freshness),
      execution_capability: EXECUTION_CAPABILITY,
      execution_authorization: EXECUTION_AUTHORIZATION,
      source_mode: this.sourceMode,
    });
  }
}
