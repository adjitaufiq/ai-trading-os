// Stage 3.0B-2C — typed, READ-ONLY client for the 2B gateway.
// One explicit method per approved route. No generic method/route selection exists.
import { TIMEFRAME_MS, type Timeframe } from "../../contracts";
import type { CanonicalClock } from "../../temporal/CanonicalClock";
import type { BridgeError } from "../bridge/types";
import type { GatewayConfig } from "./config";
import { GatewayHealthModel, NO_FRESHNESS_POLICY, type MarketDataFreshnessPolicy, type MonotonicClock } from "./health";
import { SequenceTracker } from "./SequenceTracker";
import type {
  BarHistoryRequest,
  BridgeBar,
  BridgeHealth,
  BridgeSymbolInfo,
  BridgeTick,
  ClientError,
  ClientErrorKind,
  ClientTickObservation,
  ClientTiming,
  GatewayHealthState,
  GatewayResult,
  MarketDataSubscription,
  TerminalInfoObservation,
  TickHistoryRequest,
  WireEnvelope,
  WireHistoryResult,
} from "./types";
import { validateEnvelope, type PayloadKind } from "./validate";

export type FetchLike = (url: string, init: { method: "GET"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface BrokerGatewayClientOptions {
  readonly config: GatewayConfig;
  /** Client wall clock for audit timestamps (LiveClock in the app, ReplayClock in tests). */
  readonly wallClock: CanonicalClock;
  /** Client monotonic clock for RTT/age durations. */
  readonly monoClock: MonotonicClock;
  readonly fetchImpl?: FetchLike;
  readonly wsFactory?: WebSocketFactory;
  readonly freshnessPolicy?: MarketDataFreshnessPolicy;
}

const SYMBOL_RE = /^[A-Za-z0-9._#-]{1,32}$/;
const GROUP_RE = /^[A-Za-z0-9*!,._\\-]{1,64}$/;
const MAX_COUNT = 100_000;

export class GatewayRequestError extends Error {}

export type StreamState = "CONNECTING" | "OPEN" | "CLOSED";
export interface MarketDataHandlers {
  onTick(o: ClientTickObservation): void;
  onError?(e: ClientError): void;
  onClose?(info: { code: number | null }): void;
}
export interface MarketDataStream {
  readonly state: StreamState;
  close(): void;
}

function utcIso(ms: number, name: string): string {
  if (!Number.isSafeInteger(ms)) throw new GatewayRequestError(`${name} must be integer UTC epoch ms`);
  return new Date(ms).toISOString(); // always ...Z: timezone explicit, no broker offset applied
}
function count(n: number, name: string, lo: number): string {
  if (!Number.isSafeInteger(n) || n < lo || n > MAX_COUNT) throw new GatewayRequestError(`${name} out of range`);
  return String(n);
}
function sym(s: string): string {
  if (!SYMBOL_RE.test(s)) throw new GatewayRequestError("invalid symbol");
  return encodeURIComponent(s);
}

export class BrokerGatewayClient {
  private readonly fetchImpl: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  readonly tracker = new SequenceTracker();
  readonly health: GatewayHealthModel;
  private readonly errors: ClientError[] = [];

  constructor(private readonly o: BrokerGatewayClientOptions) {
    this.fetchImpl = o.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.wsFactory = o.wsFactory ?? ((url) => new globalThis.WebSocket(url) as unknown as WebSocketLike);
    this.health = new GatewayHealthModel(o.monoClock, o.freshnessPolicy ?? NO_FRESHNESS_POLICY);
  }

  get protocolErrors(): readonly ClientError[] {
    return this.errors;
  }

  // ---------- approved routes ----------
  async getHealth(): Promise<GatewayResult<BridgeHealth>> {
    const r = await this.get<BridgeHealth>("/v1/health", "HEALTH");
    this.health.recordHealthProbe(r);
    return r;
  }
  async getTerminal(): Promise<GatewayResult<TerminalInfoObservation>> {
    const r = await this.get<TerminalInfoObservation>("/v1/terminal", "TERMINAL");
    this.health.recordTerminalProbe(r);
    return r;
  }
  getSymbols(group?: string): Promise<GatewayResult<readonly BridgeSymbolInfo[]>> {
    return this.guard(() => {
      if (group !== undefined && !GROUP_RE.test(group)) throw new GatewayRequestError("invalid group filter");
      const q = group === undefined ? "" : `?${new URLSearchParams({ group })}`;
      return this.get<readonly BridgeSymbolInfo[]>(`/v1/symbols${q}`, "SYMBOLS");
    });
  }
  getSymbol(symbol: string): Promise<GatewayResult<BridgeSymbolInfo>> {
    return this.guard(() => this.get<BridgeSymbolInfo>(`/v1/symbols/${sym(symbol)}`, "SYMBOL"));
  }
  getLatestTick(symbol: string): Promise<GatewayResult<BridgeTick>> {
    return this.guard(() => this.get<BridgeTick>(`/v1/ticks/latest/${sym(symbol)}`, "TICK"));
  }
  getTicks(req: TickHistoryRequest): Promise<GatewayResult<WireHistoryResult<BridgeTick>>> {
    return this.guard(() => {
      const q = req.mode === "range"
        ? { mode: "range", from: utcIso(req.from, "from"), to: utcIso(req.to, "to") }
        : { mode: "from", from: utcIso(req.from, "from"), count: count(req.count, "count", 1) };
      if (req.mode === "range" && req.from >= req.to) throw new GatewayRequestError("from must be earlier than to");
      return this.get<WireHistoryResult<BridgeTick>>(`/v1/ticks/${sym(req.symbol)}?${new URLSearchParams(q)}`, "TICK_HISTORY");
    });
  }
  getBars(req: BarHistoryRequest): Promise<GatewayResult<WireHistoryResult<BridgeBar>>> {
    return this.guard(() => {
      if (!Object.prototype.hasOwnProperty.call(TIMEFRAME_MS, req.timeframe)) throw new GatewayRequestError("unsupported timeframe");
      const tf: Timeframe = req.timeframe;
      const q = req.mode === "range"
        ? { mode: "range", from: utcIso(req.from, "from"), to: utcIso(req.to, "to") }
        : req.mode === "from"
          ? { mode: "from", from: utcIso(req.from, "from"), count: count(req.count, "count", 1) }
          : { mode: "pos", start: count(req.start, "start", 0), count: count(req.count, "count", 1) };
      if (req.mode === "range" && req.from >= req.to) throw new GatewayRequestError("from must be earlier than to");
      return this.get<WireHistoryResult<BridgeBar>>(`/v1/bars/${sym(req.symbol)}/${tf}?${new URLSearchParams(q)}`, "BAR_HISTORY");
    });
  }

  /** Probe gateway + terminal and return the decomposed health snapshot. Never throws. */
  async probeHealth(): Promise<GatewayHealthState> {
    const h = await this.getHealth();
    if (h.ok) await this.getTerminal();
    return this.health.snapshot();
  }

  /** Read-only typed tick subscription. The only message ever sent is the typed subscribe. */
  subscribeMarketData(sub: MarketDataSubscription, handlers: MarketDataHandlers): MarketDataStream {
    if (sub.stream !== "ticks") throw new GatewayRequestError("only stream=ticks is supported");
    if (!Array.isArray(sub.symbols) || sub.symbols.length < 1 || sub.symbols.length > 10 || !sub.symbols.every((s) => SYMBOL_RE.test(s)))
      throw new GatewayRequestError("symbols must be 1..10 valid symbols");
    const message = JSON.stringify({ action: "subscribe", stream: "ticks", symbols: [...sub.symbols] });
    let state: StreamState = "CONNECTING";
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(`${this.o.config.wsBaseUrl}/v1/stream`);
    } catch {
      const e = this.err("TRANSPORT_ERROR", "websocket could not be created", null, null, null, null);
      queueMicrotask(() => { handlers.onError?.(e); handlers.onClose?.({ code: null }); });
      return { get state() { return "CLOSED" as StreamState; }, close() {} };
    }
    ws.onopen = () => {
      state = "OPEN";
      ws.send(message);
    };
    ws.onmessage = (ev) => this.onStreamMessage(ev.data, handlers);
    ws.onerror = () => handlers.onError?.(this.err("TRANSPORT_ERROR", "websocket transport error", null, null, null, null));
    ws.onclose = (ev) => {
      if (state === "CLOSED") return;
      state = "CLOSED";
      this.health.recordStreamClosed();
      handlers.onClose?.({ code: typeof ev?.code === "number" ? ev.code : null });
    };
    return {
      get state() { return state; },
      close: () => {
        if (state === "CLOSED") return;
        ws.close(1000);
      },
    };
  }

  /** Expand a history result into fully provenanced BACKFILL tick observations. */
  tickObservations(r: GatewayResult<WireHistoryResult<BridgeTick>> | GatewayResult<BridgeTick>): readonly ClientTickObservation[] {
    if (!r.ok) return [];
    const items: readonly BridgeTick[] = "items" in r.data ? r.data.items : [r.data as BridgeTick];
    return items.map((t, i) => this.observation(r.envelope as WireEnvelope<unknown>, t, i, r.timing, r.sequence));
  }

  // ---------- internals ----------
  private async guard<T>(f: () => Promise<GatewayResult<T>>): Promise<GatewayResult<T>> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof GatewayRequestError) return { ok: false, error: this.err("INVALID_REQUEST", e.message, null, null, null, null), sequence: null };
      throw e; // programming misuse stays an exception
    }
  }

  private timing(sentAt: number | null, sentMono: number | null, bridgeSentAt: number | null): ClientTiming {
    const receivedAt = this.o.wallClock.now();
    const receivedMono = this.o.monoClock.now();
    return Object.freeze({
      client_sent_at: sentAt,
      client_received_at: receivedAt,
      client_sent_mono: sentMono,
      client_received_mono: receivedMono,
      transport_rtt_ms: sentMono === null ? null : receivedMono - sentMono,
      bridge_to_client_apparent_delay_ms: bridgeSentAt === null ? null : receivedAt - bridgeSentAt,
    });
  }

  private err(kind: ClientErrorKind, message: string, status: number | null, be: BridgeError | null,
    env: WireEnvelope<unknown> | null, timing: ClientTiming | null): ClientError {
    const e: ClientError = Object.freeze({
      kind, message, http_status: status, bridge_error: be,
      envelope: env ? Object.freeze({ bridge_instance_id: env.bridge_instance_id, connection_epoch: env.connection_epoch, request_id: env.request_id, sequence: env.sequence }) : null,
      timing,
    });
    if (kind === "CLIENT_PROTOCOL_ERROR" || kind === "HTTP_PROTOCOL_ERROR") this.errors.push(e);
    return e;
  }

  private mapBridgeError(status: number, e: BridgeError): ClientErrorKind {
    if (e.kind === "NOT_FOUND") return "NOT_FOUND";
    if (e.kind === "INVALID_REQUEST") return "INVALID_REQUEST";
    if (e.kind === "CAPABILITY_DENIED") return "GATEWAY_ERROR";
    return status >= 500 && e.message === "INTERNAL_GATEWAY_ERROR" ? "GATEWAY_ERROR" : "MT5_ERROR";
  }

  private async get<T>(path: string, kind: PayloadKind): Promise<GatewayResult<T>> {
    const sentAt = this.o.wallClock.now();
    const sentMono = this.o.monoClock.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.config.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(`${this.o.config.httpBaseUrl}${path}`, { method: "GET", signal: ctl.signal, headers: { Accept: "application/json" } });
      status = res.status;
      text = await res.text();
    } catch {
      const t = this.timing(sentAt, sentMono, null);
      const k: ClientErrorKind = ctl.signal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR";
      return { ok: false, error: this.err(k, k === "TIMEOUT" ? "request timed out" : "gateway unreachable", null, null, null, t), sequence: null };
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      const t = this.timing(sentAt, sentMono, null);
      return { ok: false, error: this.err(status === 200 ? "CLIENT_PROTOCOL_ERROR" : "HTTP_PROTOCOL_ERROR", "response body is not JSON", status, null, null, t), sequence: null };
    }
    const v = validateEnvelope<T>(body, kind);
    if (!v.ok) {
      const t = this.timing(sentAt, sentMono, null);
      const looksEnvelope = typeof body === "object" && body !== null && "schema_version" in body;
      const k: ClientErrorKind = status === 200 || looksEnvelope ? "CLIENT_PROTOCOL_ERROR" : "HTTP_PROTOCOL_ERROR";
      return { ok: false, error: this.err(k, k === "CLIENT_PROTOCOL_ERROR" ? v.reason : `HTTP ${status} without envelope`, status, null, null, t), sequence: null };
    }
    const env = v.envelope;
    const t = this.timing(sentAt, sentMono, env.timing.bridge_sent_at);
    if (env.ok !== (status === 200)) {
      return { ok: false, error: this.err("CLIENT_PROTOCOL_ERROR", `HTTP ${status} disagrees with envelope ok=${env.ok}`, status, null, env, t), sequence: null };
    }
    const seq = this.tracker.track("HTTP", env);
    if (!env.ok) {
      return { ok: false, error: this.err(this.mapBridgeError(status, env.error), env.error.message, status, env.error, env, t), sequence: seq };
    }
    return { ok: true, data: env.data, envelope: env, timing: t, sequence: seq };
  }

  private onStreamMessage(data: unknown, h: MarketDataHandlers): void {
    let body: unknown;
    try {
      body = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      h.onError?.(this.err("CLIENT_PROTOCOL_ERROR", "stream message is not JSON", null, null, null, this.timing(null, null, null)));
      return;
    }
    const v = validateEnvelope<BridgeTick>(body, "TICK");
    if (!v.ok) {
      h.onError?.(this.err("CLIENT_PROTOCOL_ERROR", v.reason, null, null, null, this.timing(null, null, null)));
      return;
    }
    const env = v.envelope;
    // Unsolicited event: no 1:1 client request, so transport_rtt_ms is null (never fabricated).
    const t = this.timing(null, null, env.timing.bridge_sent_at);
    const seq = this.tracker.track("STREAM", env);
    if (!env.ok) {
      h.onError?.(this.err(this.mapBridgeError(0, env.error), env.error.message, null, env.error, env, t));
      return;
    }
    const o = this.observation(env, env.data, 0, t, seq);
    this.health.recordTick(o);
    h.onTick(o);
  }

  private observation(env: WireEnvelope<unknown>, tick: BridgeTick, idx: number, t: ClientTiming,
    seq: { disposition: ClientTickObservation["sequence_disposition"]; observations: ClientTickObservation["sequence_observations"] }): ClientTickObservation {
    return Object.freeze({
      raw_event_id: `gw:${env.bridge_instance_id}:e${env.connection_epoch}:s${env.sequence}:i${idx}`,
      tick: Object.freeze({ ...tick }),
      bridge_instance_id: env.bridge_instance_id,
      connection_epoch: env.connection_epoch,
      request_id: env.request_id,
      sequence: env.sequence,
      item_index: idx,
      source: env.source,
      source_mode: env.source_mode,
      delivery: env.delivery,
      bridge_timing: env.timing,
      bridge_latency: env.latency,
      client_timing: t,
      sequence_disposition: seq.disposition,
      sequence_observations: seq.observations,
    });
  }
}
