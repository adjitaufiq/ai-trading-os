// D2 — Canonical Market Runtime: the ONE composition root of the Stage 3 chain.
// gateway port (validation inside BrokerGatewayClient) → BootstrapCoordinator → ObservationIdentity
// → BrokerFeedPipeline (BrokerNormalizer + AnomalyClassifier) → LIVE_MUTATION → LiveCandleFanout
// → M5/M15/H1/H4 CandleAggregators → CandleStore (CLOSED read model).
// React never owns these transitions; consumers get a narrow, frozen, read-only MarketRuntimeReader.
// MONITOR_ONLY. No execution surface exists here.
import { TIMEFRAME_MS, type Bar, type Timeframe } from "../contracts";
import type { CanonicalClock } from "../temporal/CanonicalClock";
import type { ClassifierConfig } from "../broker/AnomalyClassifier";
import { BrokerFeedPipeline, type AuditRecord, type FeedRoute } from "../broker/BrokerFeedPipeline";
import { LIVE_FANOUT_TIMEFRAMES, LiveCandleFanout } from "../broker/LiveCandleFanout";
import type { BrokerMarketEvent, SymbolSpecification } from "../broker/types";
import { BootstrapCoordinator, type BootstrapSnapshot, type BootstrapState } from "../broker/bootstrap/BootstrapCoordinator";
import { ObservationIdentityRegistry, type ObservationOccurrence } from "../broker/identity/ObservationIdentity";
import { CandleStore, type CandleStoreMetrics } from "../candles/CandleStore";
import { detectMissingIntervals, type MissingInterval } from "../candles/MissingInterval";
import { RadarRuntimeService } from "../radar/RadarRuntimeService";
import type { RadarHealth, RadarSnapshot } from "../radar/types";
import { LivePaperLoop, type VirtualAccountView } from "../paper/LivePaperLoop";
import type { JournalTrade } from "../../engine/journal/types";
import type { MarketDataHandlers, MarketDataStream } from "../broker/gateway/BrokerGatewayClient";
import type {
  BridgeHealth, BridgeTick, ClientTickObservation, GatewayResult, MarketDataSubscription, TickHistoryRequest, WireHistoryResult,
} from "../broker/gateway/types";

/** Gateway boundary. BrokerGatewayClient satisfies it; tests inject the same client over a hermetic transport. */
export interface MarketGatewayPort {
  getHealth(): Promise<GatewayResult<BridgeHealth>>;
  getTicks(req: TickHistoryRequest): Promise<GatewayResult<WireHistoryResult<BridgeTick>>>;
  subscribeMarketData(sub: MarketDataSubscription, handlers: MarketDataHandlers): MarketDataStream;
  tickObservations(r: GatewayResult<WireHistoryResult<BridgeTick>>): readonly ClientTickObservation[];
}

export interface MarketRuntimeOptions {
  readonly gateway: MarketGatewayPort;
  readonly clock: CanonicalClock;
  /** Explicit, already-resolved binding. Never guessed. */
  readonly binding: { readonly broker_symbol: string; readonly canonical_symbol: string };
  /** broker_utc_offset_ms must be supplied explicitly by the caller (G2 open: no default, no guess). */
  readonly spec: SymbolSpecification;
  readonly classifier: ClassifierConfig;
  /** Bounded CLOSED retention per timeframe. */
  readonly maxClosedBarsPerTimeframe: number;
}

export type HeldReason = "SEQUENCE_QUARANTINE" | "SYMBOL_NOT_BOUND" | "AWAITING_REBOOTSTRAP" | "SINK_FAULT";
export interface HeldObservation { readonly reason: HeldReason; readonly raw_event_id: string; readonly connection_epoch: number; readonly detail: string | null }

export interface TimeframeView {
  readonly timeframe: Timeframe;
  readonly closed: readonly Bar[];
  readonly forming: Bar | null;
  readonly store: CandleStoreMetrics;
}

export interface MarketRuntimeSnapshot {
  readonly kind: "CANONICAL_MARKET_RUNTIME";
  readonly operating_mode: "MONITOR_ONLY";
  readonly execution_enabled: false;
  readonly symbol: string;
  readonly lifecycle: "IDLE" | "STARTING" | "RUNNING" | "STOPPED";
  readonly bootstrap_state: BootstrapState;
  readonly active_epoch: number | null;
  readonly degraded_reason: string | null;
  readonly history_coverage_status: string | null;
  /** History request completion never proves market completeness. */
  readonly market_coverage_proven_complete: false;
  readonly route_counts: Readonly<Record<FeedRoute, number>>;
  readonly held: readonly HeldObservation[];
  readonly silent_ambiguous_drops: number;
  /** LIVE stream frames rejected by the client protocol validator (surfaced, never hidden or repaired). */
  readonly stream_protocol_errors: number;
  readonly last_stream_error: string | null;
  readonly timeframes: Readonly<Record<Timeframe, TimeframeView>>;
}

/** The ONLY surface consumers (probe, terminal later, /audit) receive. No mutators. */
export interface MarketRuntimeReader {
  readonly symbol: string;
  closedBars(tf: Timeframe): readonly Bar[];
  formingBar(tf: Timeframe): Bar | null;
  missingIntervals(tf: Timeframe): readonly MissingInterval[];
  snapshot(): MarketRuntimeSnapshot;
  /** Latest observation that actually reached the LIVE sink (LIVE_MUTATION only). Never BACKFILL/RECONCILE. */
  latestLiveObservation(): BrokerMarketEvent | null;
  /** Broker-reported CLOSED history bars (BACKFILL provenance; never live candles, never in CandleStore). */
  brokerHistoryBars?(tf: Timeframe): readonly BrokerHistoryBar[];
  /** event_at of the first LIVE_MUTATION; canonical bars opening before it may be partial. */
  firstLiveEventAt?(): number | null;
  /** Frozen radar-v1 read model, recomputed only on CLOSED M5 bars (authority NONE). Null until warmed up. */
  radarSnapshot(): Readonly<RadarSnapshot> | null;
  radarHealth(): Readonly<RadarHealth>;
  /** Virtual paper account (PAPER ONLY, no broker). */
  paperAccount?(): Readonly<VirtualAccountView>;
  /** M6 journal rows produced by the live paper loop, tagged with dataSource. */
  paperTrades?(): readonly Readonly<JournalTrade>[];
  now(): number;
}

/** Broker /v1/bars CLOSED bar. open_time on the measured broker time axis (offset 0 verified at mount, G2). */
export interface BrokerHistoryBar {
  readonly provenance: "BROKER_BACKFILL_BAR";
  readonly timeframe: Timeframe;
  readonly open_time: number;
  readonly close_time: number;
  /** Clock time when this system received the bar (fetch completion). */
  readonly available_at: number;
  readonly open: number; readonly high: number; readonly low: number; readonly close: number;
}

export interface StartRequest { readonly history_from: number; readonly history_to: number }

export class MarketRuntime {
  private readonly fanout: LiveCandleFanout;
  private readonly pipeline: BrokerFeedPipeline;
  private readonly boot: BootstrapCoordinator;
  private readonly stores: Record<Timeframe, CandleStore>;
  private readonly routeCounts: Record<FeedRoute, number> = { LIVE_MUTATION: 0, BACKFILL_HISTORY: 0, RECONCILIATION_CANDIDATE: 0, QUARANTINED: 0, REJECTED: 0 };
  private readonly held: HeldObservation[] = [];
  private pending: ObservationOccurrence[] = [];
  private stream: MarketDataStream | null = null;
  private lifecycle: MarketRuntimeSnapshot["lifecycle"] = "IDLE";
  private coverageStatus: string | null = null;
  private lastRequest: StartRequest | null = null;
  private lastLive: BrokerMarketEvent | null = null;
  private firstLiveAt: number | null = null;
  private readonly history = { M5: [], M15: [], H1: [], H4: [] } as Record<Timeframe, readonly BrokerHistoryBar[]>;
  private streamErrors = 0;
  private lastStreamError: string | null = null;
  private readonly maxHeld = 1000;
  readonly reader: MarketRuntimeReader;
  private readonly radar: RadarRuntimeService;
  private readonly paper: LivePaperLoop;

  constructor(private readonly o: MarketRuntimeOptions) {
    const sym = o.binding.canonical_symbol;
    this.fanout = new LiveCandleFanout(sym, o.clock, o.classifier.maxSourceTimeSkewMs ?? 0);
    this.stores = {} as Record<Timeframe, CandleStore>;
    for (const tf of LIVE_FANOUT_TIMEFRAMES) {
      this.stores[tf] = new CandleStore(sym, tf, o.maxClosedBarsPerTimeframe);
      this.stores[tf].attach(this.fanout.aggregators[tf]);
    }
    this.radar = new RadarRuntimeService(sym, o.spec.origin === "BROKER_REPORTED" ? { mode: "REAL", provider: "EXNESS_MT5", feedId: o.binding.broker_symbol } : { mode: "SYNTHETIC", feedId: o.binding.broker_symbol });
    // radar evaluates on CLOSED M5 only (after the store has appended it); forming emissions are ignored
    this.fanout.aggregators.M5.onBar((b) => { if (b.status === "CLOSED") this.radar.onClosedM5(b, (tf) => this.stores[tf].closed, o.clock.now()); });
    this.paper = new LivePaperLoop(sym, o.spec.origin === "BROKER_REPORTED" ? "REAL_MT5" : "SYNTHETIC", o.spec);
    // paper loop runs after the radar on the same CLOSED M5 emission; fills use the latest LIVE bid/ask
    this.fanout.aggregators.M5.onBar((b) => { if (b.status === "CLOSED") this.paper.onClosedM5(b, (tf) => this.stores[tf].closed, this.lastLive); });
    const count = (r: AuditRecord) => { this.routeCounts[r.route]++; };
    this.pipeline = new BrokerFeedPipeline(o.spec, o.classifier, o.clock, (e) => { this.fanout.ingest(e); this.lastLive = e; this.paper.mark(e); if (this.firstLiveAt === null) this.firstLiveAt = e.event_at; });
    const pipe = this.pipeline;
    this.boot = new BootstrapCoordinator({ process: (env, id) => { const r = pipe.process(env, id); count(r); return r; } }, new ObservationIdentityRegistry());
    this.reader = this.makeReader();
  }

  /** Startup: health → epoch → BUFFERING_LIVE → subscribe → FETCHING_HISTORY → replay → drain → SYNCHRONIZED | DEGRADED. */
  async start(req: StartRequest): Promise<BootstrapState> {
    if (this.lifecycle === "STARTING") throw new Error("runtime already starting");
    this.lifecycle = "STARTING";
    this.lastRequest = req;
    const h = await this.o.gateway.getHealth();
    if (!h.ok) {
      this.lifecycle = "STOPPED";
      this.coverageStatus = null;
      return this.boot.state; // never fabricate an epoch; stays UNINITIALIZED / previous state
    }
    await this.bootstrap(h.envelope.connection_epoch, req);
    this.lifecycle = "RUNNING";
    return this.boot.state;
  }

  /** Re-bootstrap after an epoch change (or a DEGRADED run). Earlier runs stay archived in the coordinator. */
  async rebootstrap(req: StartRequest | null = this.lastRequest): Promise<BootstrapState> {
    if (!req) throw new Error("no history request");
    const h = await this.o.gateway.getHealth();
    if (!h.ok) return this.boot.state;
    await this.bootstrap(h.envelope.connection_epoch, req);
    return this.boot.state;
  }

  private async bootstrap(epoch: number, req: StartRequest): Promise<void> {
    this.boot.start(epoch);
    const carry = this.pending.filter((p) => p.connection_epoch >= epoch);
    this.pending = [];
    for (const p of carry) this.safeLive(p);
    if (!this.stream) {
      // Subscribed only after BUFFERING_LIVE, so every LIVE observation is buffered by the coordinator.
      this.stream = this.o.gateway.subscribeMarketData({ stream: "ticks", symbols: [this.o.binding.broker_symbol] }, {
        onTick: (t) => this.onGatewayTick(t),
        onError: (e) => { this.streamErrors++; this.lastStreamError = `${e.kind}: ${e.message}`; },
      });
    }
    this.boot.beginHistory({ requested_from: req.history_from, requested_to: req.history_to });
    // Live that arrives while the history request is in flight is buffered by the coordinator.
    const r = await this.o.gateway.getTicks({ symbol: this.o.binding.broker_symbol, mode: "range", from: req.history_from, to: req.history_to });
    if (!r.ok) {
      this.coverageStatus = null;
      this.boot.historyFailed(`${r.error.kind}: ${r.error.message}`);
      return;
    }
    const c = r.data.coverage;
    this.coverageStatus = c.coverage_status;
    const items: ObservationOccurrence[] = [];
    for (const t of this.o.gateway.tickObservations(r)) {
      const occ = this.toOccurrence(t, "HISTORY");
      if (occ) items.push(occ);
    }
    this.boot.historyReceived(items, {
      // Wire bounds may be null; the request bounds the runtime itself sent are recorded instead (never invented).
      requested_from: c.requested_from ?? req.history_from, requested_to: c.requested_to ?? req.history_to, returned_count: c.returned_count,
      oldest_returned_at: c.oldest_returned_at, newest_returned_at: c.newest_returned_at, coverage_status: c.coverage_status,
      ...(c.reason === null ? {} : { reason: c.reason }),
    });
  }

  /** Real ingestion boundary for LIVE stream observations. */
  private onGatewayTick(t: ClientTickObservation): void {
    const occ = this.toOccurrence(t, "STREAM");
    if (!occ) return;
    const active = this.boot.snapshot().active_epoch;
    if (active !== null && occ.connection_epoch > active) {
      // Continuity break: degrade, keep the new-epoch observation for the re-bootstrap (never discarded).
      this.boot.onEpochChange(occ.connection_epoch);
      if (this.boot.state === "SYNCHRONIZED" || this.boot.state === "DEGRADED") {
        this.pending.push(occ);
        this.hold("AWAITING_REBOOTSTRAP", occ.raw_event_id, occ.connection_epoch, null);
        return;
      }
    }
    this.safeLive(occ);
  }

  private safeLive(occ: ObservationOccurrence): void {
    try {
      this.boot.onLive(occ);
    } catch (e) {
      this.hold("SINK_FAULT", occ.raw_event_id, occ.connection_epoch, (e as Error).message);
    }
  }

  /**
   * Seed/refresh broker CLOSED history for the technical read model. BACKFILL provenance: it never enters the
   * live fanout, CandleStore or frontier. Only bars with close_time <= clock now are kept (forming excluded).
   * Replacement is whole-window (broker reconciliation), bounded by maxClosedBarsPerTimeframe.
   */
  seedBrokerHistory(tf: Timeframe, bars: readonly { open_time: number; open: number; high: number; low: number; close: number }[]): number {
    const now = this.o.clock.now(), ms = TIMEFRAME_MS[tf];
    const out: BrokerHistoryBar[] = [];
    for (const b of bars) {
      const close_time = b.open_time + ms;
      if (close_time > now) continue;
      if (out.length && b.open_time <= out[out.length - 1]!.open_time) throw new Error(`broker history ${tf} not strictly ascending`);
      out.push(Object.freeze({ provenance: "BROKER_BACKFILL_BAR", timeframe: tf, open_time: b.open_time, close_time, available_at: now, open: b.open, high: b.high, low: b.low, close: b.close }));
    }
    this.history[tf] = Object.freeze(out.slice(-this.o.maxClosedBarsPerTimeframe));
    return this.history[tf].length;
  }

  /** Time-driven closure through the canonical clock only. */
  checkBoundaries(): void {
    this.fanout.checkBoundary();
  }

  stop(): void {
    this.stream?.close();
    this.stream = null;
    this.lifecycle = "STOPPED";
  }

  private toOccurrence(t: ClientTickObservation, channel: "STREAM" | "HISTORY"): ObservationOccurrence | null {
    if (t.sequence_disposition === "QUARANTINE") { this.hold("SEQUENCE_QUARANTINE", t.raw_event_id, t.connection_epoch, null); return null; }
    if (t.tick.broker_symbol !== this.o.binding.broker_symbol) { this.hold("SYMBOL_NOT_BOUND", t.raw_event_id, t.connection_epoch, t.tick.broker_symbol); return null; }
    return Object.freeze<ObservationOccurrence>({
      raw_event_id: t.raw_event_id, source: t.source, broker_symbol: t.tick.broker_symbol, canonical_symbol: this.o.binding.canonical_symbol,
      bridge_instance_id: t.bridge_instance_id, connection_epoch: t.connection_epoch, channel, request_id: t.request_id,
      sequence: t.sequence, item_index: t.item_index, delivery: t.delivery === "LIVE" ? "LIVE" : "BACKFILL",
      source_event_ms: t.tick.raw_time_msc, bid: t.tick.bid, ask: t.tick.ask, last: t.tick.last, volume: t.tick.volume, flags: t.tick.flags,
      received_at: t.bridge_timing.bridge_received_at,
    });
  }

  private hold(reason: HeldReason, raw_event_id: string, connection_epoch: number, detail: string | null): void {
    this.held.push(Object.freeze({ reason, raw_event_id, connection_epoch, detail }));
    while (this.held.length > this.maxHeld) this.held.shift();
  }

  /** Bootstrap audit (read-only, frozen) for diagnostics. */
  bootstrapSnapshot(): BootstrapSnapshot { return this.boot.snapshot(); }
  get archivedBootstraps(): readonly BootstrapSnapshot[] { return this.boot.archivedSnapshots; }

  private makeReader(): MarketRuntimeReader {
    const self = this;
    const sym = this.o.binding.canonical_symbol;
    const closed = (tf: Timeframe) => Object.freeze([...self.stores[tf].closed]);
    const forming = (tf: Timeframe) => self.fanout.aggregators[tf].current;
    return Object.freeze<MarketRuntimeReader>({
      symbol: sym,
      closedBars: closed,
      formingBar: forming,
      now: () => self.o.clock.now(),
      latestLiveObservation: () => self.lastLive,
      brokerHistoryBars: (tf) => self.history[tf],
      firstLiveEventAt: () => self.firstLiveAt,
      radarSnapshot: () => self.radar.snapshot(),
      radarHealth: () => self.radar.health(self.o.clock.now()),
      paperAccount: () => self.paper.account(),
      paperTrades: () => self.paper.trades(),
      missingIntervals(tf) {
        const c = closed(tf);
        if (c.length < 2) return Object.freeze([]);
        return detectMissingIntervals(c, c[0]!.open_time, c[c.length - 1]!.close_time, {
          symbol: sym, timeframe: tf, detected_at: self.o.clock.now(), source_context: "canonical runtime CLOSED candles",
        });
      },
      snapshot() {
        const b = self.boot.snapshot();
        const tfs = {} as Record<Timeframe, TimeframeView>;
        for (const tf of LIVE_FANOUT_TIMEFRAMES) tfs[tf] = Object.freeze({ timeframe: tf, closed: closed(tf), forming: forming(tf), store: self.stores[tf].metrics });
        return Object.freeze<MarketRuntimeSnapshot>({
          kind: "CANONICAL_MARKET_RUNTIME", operating_mode: "MONITOR_ONLY", execution_enabled: false, symbol: sym,
          lifecycle: self.lifecycle, bootstrap_state: b.state, active_epoch: b.active_epoch, degraded_reason: b.degraded_reason,
          history_coverage_status: self.coverageStatus, market_coverage_proven_complete: false,
          route_counts: Object.freeze({ ...self.routeCounts }), held: Object.freeze([...self.held]),
          silent_ambiguous_drops: self.boot.metrics.silent_ambiguous_drops,
          stream_protocol_errors: self.streamErrors, last_stream_error: self.lastStreamError, timeframes: Object.freeze(tfs),
        });
      },
    });
  }
}

export const RUNTIME_TIMEFRAME_MS = TIMEFRAME_MS;
