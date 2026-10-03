// Stage 3.0B-1 — deterministic mock of the read-only bridge.
// No terminal, no network, no secrets. Time comes only from a ReplayClock.
import { TIMEFRAME_MS, type Timeframe } from "../../contracts";
import { ReplayClock } from "../../temporal/CanonicalClock";
import { BASE_BRIDGE_SCRIPT, BRIDGE_T0, type SyntheticBridgeScript } from "../../fixtures/syntheticBridgeFixture";
import {
  BRIDGE_SCHEMA_VERSION, READ_ONLY_CAPABILITIES,
  type BridgeBar, type BridgeCapability, type BridgeDelivery, type BridgeEnvelope, type BridgeError,
  type BridgeHealth, type BridgeSymbolInfo, type BridgeTick, type ClockOffsetObservation, type HistoryCoverage,
  type HistoryResult, type Mt5Error, type ReadOnlyBridgeClient, type SymbolResolution, type TerminalInfoObservation,
} from "./types";

export class CapabilityDeniedError extends Error {
  constructor(readonly capability: string) {
    super(`Capability "${capability}" is not in the read-only whitelist`);
  }
}

export function isWhitelisted(c: string): c is BridgeCapability {
  return (READ_ONLY_CAPABILITIES as readonly string[]).includes(c);
}
export function assertCapability(c: string): asserts c is BridgeCapability {
  if (!isWhitelisted(c)) throw new CapabilityDeniedError(c);
}

export const pingUsToMs = (us: number): number => us / 1000;

/** Raw last_error() tuple → public wire shape. */
export function toMt5Error(raw: readonly [number, string]): Mt5Error {
  return { code: raw[0], description: raw[1] };
}

/** MT5-style group filter: comma-separated, `*` wildcard, `!` exclusion. */
export function matchesGroup(symbol: string, group: string): boolean {
  const conds = group.split(",").map((s) => s.trim()).filter(Boolean);
  const toRe = (p: string) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
  const inc = conds.filter((c) => !c.startsWith("!"));
  const exc = conds.filter((c) => c.startsWith("!")).map((c) => c.slice(1));
  return inc.some((p) => toRe(p).test(symbol)) && !exc.some((p) => toRe(p).test(symbol));
}

/** canonical "XAUUSD" → base XAU / profit USD (6-char FX-style only). */
function canonicalParts(canonical: string): { base: string; profit: string } | null {
  return /^[A-Z]{6}$/.test(canonical) ? { base: canonical.slice(0, 3), profit: canonical.slice(3) } : null;
}

/** Conservative coverage. Completeness is never inferred from returned_count. */
export function computeBarCoverage(bars: readonly BridgeBar[], tf: Timeframe, fromS: number, toS: number, historySynced: boolean): HistoryCoverage {
  const base = { requested_from: fromS, requested_to: toS, returned_count: bars.length };
  if (bars.length === 0) {
    return { ...base, oldest_returned_at: null, newest_returned_at: null, coverage_status: "EMPTY",
      reason: "terminal returned zero bars; absence of data is not proof of no market activity" };
  }
  const step = TIMEFRAME_MS[tf] / 1000;
  const oldest = bars[0]!.raw_time_s;
  const newest = bars[bars.length - 1]!.raw_time_s;
  const cov = { ...base, oldest_returned_at: oldest, newest_returned_at: newest };
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.raw_time_s - bars[i - 1]!.raw_time_s !== step) {
      return { ...cov, coverage_status: "PARTIAL", reason: `internal gap after ${bars[i - 1]!.raw_time_s}` };
    }
  }
  const firstExpected = Math.ceil(fromS / step) * step;
  const lastExpected = Math.ceil(toS / step) * step - step;
  if (oldest > firstExpected || newest < lastExpected) {
    return { ...cov, coverage_status: "PARTIAL", reason: "returned range does not span requested range" };
  }
  if (!historySynced) {
    return { ...cov, coverage_status: "UNKNOWN", reason: "contiguous, but terminal history sync is not proven" };
  }
  return { ...cov, coverage_status: "COMPLETE" };
}

/** Ticks have no continuity proof; COMPLETE is never claimed. */
export function computeTickCoverage(ticks: readonly BridgeTick[], fromS: number, toS: number): HistoryCoverage {
  const base = { requested_from: fromS, requested_to: toS, returned_count: ticks.length };
  if (ticks.length === 0) return { ...base, oldest_returned_at: null, newest_returned_at: null, coverage_status: "EMPTY", reason: "terminal returned zero ticks" };
  return { ...base, oldest_returned_at: ticks[0]!.raw_time_msc, newest_returned_at: ticks[ticks.length - 1]!.raw_time_msc,
    coverage_status: "UNKNOWN", reason: "tick continuity cannot be proven from a terminal response" };
}

export interface InternalProvenanceRecord {
  readonly request_id: string;
  readonly capability: BridgeCapability;
  /** Opaque last_error() representation, preserved verbatim. Never on the wire. */
  readonly raw_mt5_error: readonly [number, string] | null;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export class MockMT5BridgeClient implements ReadOnlyBridgeClient {
  readonly capabilities = READ_ONLY_CAPABILITIES;
  private seq = 0;
  private reqN = 0;
  private epoch = 1;
  private readonly provenance: InternalProvenanceRecord[] = [];

  constructor(
    private readonly script: SyntheticBridgeScript = BASE_BRIDGE_SCRIPT,
    /** Bridge (VPS) clock. Client clock = bridge + script.client_clock_offset_ms. */
    private readonly clock: ReplayClock = new ReplayClock(BRIDGE_T0),
  ) {}

  get connectionEpoch(): number { return this.epoch; }
  internalProvenance(): readonly InternalProvenanceRecord[] { return this.provenance; }

  /** Simulated reconnect: epoch increments, sequence keeps increasing. */
  reconnect(): void { this.epoch += 1; }

  private envelope<T>(cap: BridgeCapability, delivery: BridgeDelivery, sourceEventAt: number | null, produce: () => T): BridgeEnvelope<T> {
    assertCapability(cap);
    const s = this.script;
    const request_id = `${s.bridge_instance_id}-e${this.epoch}-r${++this.reqN}`;
    const client_sent_at = this.clock.now() + s.client_clock_offset_ms;
    const bridge_received_at = this.clock.now() + s.one_way_transit_ms;
    const bridge_sent_at = bridge_received_at + s.bridge_processing_ms;
    const client_received_at = bridge_sent_at + s.one_way_transit_ms + s.client_clock_offset_ms;
    this.clock.advanceTo(bridge_sent_at + s.one_way_transit_ms);

    const rawErr = s.injected_errors[cap] ?? null;
    this.provenance.push({ request_id, capability: cap, raw_mt5_error: rawErr });

    const timing = { source_event_at: rawErr ? null : sourceEventAt, bridge_received_at, bridge_sent_at, client_sent_at, client_received_at };
    const latency = {
      source_arrival_delay_observed_ms: timing.source_event_at === null ? null : bridge_received_at - timing.source_event_at,
      bridge_processing_ms: bridge_sent_at - bridge_received_at,
      bridge_to_client_apparent_delay_ms: client_received_at - bridge_sent_at,
      transport_rtt_ms: client_received_at - client_sent_at,
    };
    const base = {
      schema_version: BRIDGE_SCHEMA_VERSION, bridge_instance_id: s.bridge_instance_id, connection_epoch: this.epoch,
      request_id, sequence: ++this.seq, delivery, source: "EXNESS_MT5" as const, source_mode: "SIMULATION" as const,
      capability: cap, timing, latency,
    };
    if (rawErr) {
      const error: BridgeError = { kind: "MT5_ERROR", message: "terminal call returned None", mt5_error: toMt5Error(rawErr) };
      return deepFreeze({ ...base, ok: false as const, data: null, error });
    }
    return deepFreeze({ ...base, ok: true as const, data: produce(), error: null });
  }

  health(): BridgeEnvelope<BridgeHealth> {
    return this.envelope("SYSTEM.HEALTH", "LIVE", null, () => ({
      bridge_instance_id: this.script.bridge_instance_id, connection_epoch: this.epoch,
      source_mode: "SIMULATION", terminal_connected: this.script.terminal_connected,
    }));
  }

  terminalInfo(): BridgeEnvelope<TerminalInfoObservation> {
    const s = this.script;
    return this.envelope("SYSTEM.TERMINAL_INFO", "LIVE", null, () => ({
      connected: s.terminal_connected, terminal_ping_us: s.terminal_ping_us, terminal_ping_ms: pingUsToMs(s.terminal_ping_us),
      retransmission: s.retransmission, trade_allowed_observed: s.trade_allowed_observed,
      tradeapi_disabled_observed: s.tradeapi_disabled_observed, authority: "OBSERVATION_ONLY",
    }));
  }

  clockProbe(): BridgeEnvelope<ClockOffsetObservation> {
    let obs!: ClockOffsetObservation;
    const env = this.envelope("SYSTEM.CLOCK_PROBE", "LIVE", null, () => obs);
    if (!env.ok) return env;
    const t = env.timing;
    const rtt = t.client_received_at - t.client_sent_at;
    const bridge_at = (t.bridge_received_at + t.bridge_sent_at) / 2;
    obs = { client_sent_at: t.client_sent_at, bridge_at, client_received_at: t.client_received_at, rtt_ms: rtt,
      offset_estimate_ms: bridge_at - (t.client_sent_at + t.client_received_at) / 2, uncertainty_ms: rtt / 2 };
    return deepFreeze({ ...env, data: obs });
  }

  symbols(group: string): BridgeEnvelope<readonly BridgeSymbolInfo[]> {
    return this.envelope("DISCOVERY.SYMBOLS", "LIVE", null, () => this.script.symbols.filter((x) => matchesGroup(x.broker_symbol, group)).map((x) => ({ ...x })));
  }

  resolveSymbol(canonical: string, group: string, pinned?: string): BridgeEnvelope<SymbolResolution> {
    return this.envelope("DISCOVERY.RESOLVE_SYMBOL", "LIVE", null, () => {
      const hits = this.script.symbols.filter((x) => matchesGroup(x.broker_symbol, group));
      const parts = canonicalParts(canonical);
      const matches = parts ? hits.filter((x) => x.currency_base === parts.base && x.currency_profit === parts.profit) : [];
      const r = { canonical, group_filter: group, candidates: hits.map((x) => x.broker_symbol), metadata_matches: matches.map((x) => x.broker_symbol) };
      if (pinned !== undefined) {
        return matches.some((m) => m.broker_symbol === pinned)
          ? { ...r, status: "RESOLVED" as const, broker_symbol: pinned, reason: "USER_PINNED" as const }
          : { ...r, status: "UNRESOLVED" as const, broker_symbol: null, reason: "PIN_NOT_IN_CANDIDATES" as const };
      }
      if (matches.length === 1) return { ...r, status: "RESOLVED" as const, broker_symbol: matches[0]!.broker_symbol, reason: "UNIQUE_METADATA_MATCH" as const };
      return { ...r, status: "UNRESOLVED" as const, broker_symbol: null, reason: matches.length === 0 ? "NO_CANDIDATE" as const : "AMBIGUOUS" as const };
    });
  }

  ticks(brokerSymbol: string, fromS: number, toS: number, delivery: BridgeDelivery = "BACKFILL"): BridgeEnvelope<HistoryResult<BridgeTick>> {
    const items = (this.script.ticks[brokerSymbol] ?? []).filter((t) => t.raw_time_msc >= fromS * 1000 && t.raw_time_msc < toS * 1000);
    const last = items.length ? items[items.length - 1]!.raw_time_msc : null;
    return this.envelope("MARKET_DATA.TICKS", delivery, last, () => ({ items: items.map((t) => ({ ...t })), coverage: computeTickCoverage(items, fromS, toS) }));
  }

  bars(brokerSymbol: string, timeframe: Timeframe, fromS: number, toS: number, delivery: BridgeDelivery = "BACKFILL"): BridgeEnvelope<HistoryResult<BridgeBar>> {
    const items = (this.script.bars[`${brokerSymbol}:${timeframe}`] ?? []).filter((b) => b.raw_time_s >= fromS && b.raw_time_s < toS);
    const src = items.length ? items[items.length - 1]!.raw_time_s * 1000 : null;
    return this.envelope("MARKET_DATA.BARS", delivery, src, () => ({ items: items.map((b) => ({ ...b })), coverage: computeBarCoverage(items, timeframe, fromS, toS, this.script.history_synced) }));
  }

  invoke(capability: string): BridgeEnvelope<unknown> {
    assertCapability(capability);
    switch (capability) {
      case "SYSTEM.HEALTH": return this.health();
      case "SYSTEM.TERMINAL_INFO": return this.terminalInfo();
      case "SYSTEM.CLOCK_PROBE": return this.clockProbe();
      default: throw new CapabilityDeniedError(`${capability} requires typed arguments; use the typed method`);
    }
  }
}
