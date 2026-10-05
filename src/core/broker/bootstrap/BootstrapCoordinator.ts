// PRE-2D Patch B — R4 History → Live Bootstrap.
// UNINITIALIZED → BUFFERING_LIVE → FETCHING_HISTORY → REPLAYING_HISTORY → DRAINING_BUFFER → SYNCHRONIZED; failure → DEGRADED.
// History stays BACKFILL and goes through the existing BACKFILL_HISTORY route (never live mutation).
// The coordinator is step-driven (no timers, no Date.now) so LIVE and REPLAY runs are identical.
import type { AuditRecord } from "../BrokerFeedPipeline";
import type { BrokerEventEnvelope, RawBrokerTick } from "../types";
import {
  ObservationIdentityRegistry,
  type DedupClass,
  type IdentityClassification,
  type ObservationOccurrence,
} from "../identity/ObservationIdentity";

export type BootstrapState =
  | "UNINITIALIZED"
  | "BUFFERING_LIVE"
  | "FETCHING_HISTORY"
  | "REPLAYING_HISTORY"
  | "DRAINING_BUFFER"
  | "SYNCHRONIZED"
  | "DEGRADED";

/** Minimal pipeline surface (BrokerFeedPipeline satisfies it). */
export interface FeedPipelinePort {
  process(env: BrokerEventEnvelope<RawBrokerTick>): AuditRecord;
}

export interface BootstrapHistoryRequest {
  readonly requested_from: number;
  readonly requested_to: number;
}
export interface BootstrapHistoryCoverage {
  readonly requested_from: number;
  readonly requested_to: number;
  readonly returned_count: number;
  readonly oldest_returned_at: number | null;
  readonly newest_returned_at: number | null;
  readonly coverage_status: "COMPLETE" | "PARTIAL" | "EMPTY" | "UNKNOWN";
  readonly reason?: string;
}

export type OccurrenceAction = "FORWARDED" | "SUPPRESSED_EXACT_DUPLICATE" | "HELD_STALE_EPOCH" | "HELD_RECONCILE";

export interface OccurrenceAudit {
  readonly phase: BootstrapState;
  readonly occurrence: ObservationOccurrence;
  readonly identity: IdentityClassification;
  readonly action: OccurrenceAction;
  readonly pipeline: AuditRecord | null;
}

export interface LiveAcceptedFrontier {
  readonly event_at: number;
  readonly canonical_seq: number;
  readonly raw_event_id: string;
}
export interface HistoryRequestWatermark {
  readonly request: BootstrapHistoryRequest;
  readonly request_completed: boolean;
  readonly coverage: BootstrapHistoryCoverage | null;
  /** Always false: request completion never proves market/candle completeness. */
  readonly market_coverage_proven_complete: false;
}
export interface HandoffWatermark {
  readonly live_frontier_at_handoff: LiveAcceptedFrontier | null;
  readonly history_newest_returned_at: number | null;
}
export interface ReconciliationFrontier {
  readonly candidates: number;
  readonly last_source_event_ms: number | null;
}
/** LWM = earliest buffered LIVE source time; HWM = newest history returned. Frontiers, not identities. */
export interface TemporalSeparation {
  readonly lwm: number | null;
  readonly hwm: number | null;
  readonly relation: "OVERLAPPING" | "SEPARATED" | "UNKNOWN";
  /** LWM > HWM alone is never treated as proof of loss. */
  readonly loss_inferred: false;
}

export interface BootstrapSnapshot {
  readonly run: number;
  readonly state: BootstrapState;
  readonly active_epoch: number | null;
  readonly degraded_reason: string | null;
  readonly uncertainties: readonly string[];
  readonly history: HistoryRequestWatermark | null;
  readonly history_received: number;
  readonly buffered: readonly ObservationOccurrence[];
  readonly occurrences: readonly OccurrenceAudit[];
  readonly separation: TemporalSeparation;
  readonly live_frontier: LiveAcceptedFrontier | null;
  readonly handoff: HandoffWatermark | null;
  readonly reconciliation: ReconciliationFrontier;
  readonly transitions: readonly { from: BootstrapState; to: BootstrapState; reason: string }[];
}

export interface DedupMetrics {
  readonly by_class: Readonly<Record<DedupClass, number>>;
  readonly ambiguous_total: number;
  readonly ambiguous_audited: number;
  /** ambiguous classifications without an audit record. Must be 0. */
  readonly silent_ambiguous_drops: number;
}

export class BootstrapCoordinator {
  private _state: BootstrapState = "UNINITIALIZED";
  private run = 0;
  private activeEpoch: number | null = null;
  private degradedReason: string | null = null;
  private uncertainties: string[] = [];
  private history: HistoryRequestWatermark | null = null;
  private historyReceivedCount = 0;
  private buffer: { o: ObservationOccurrence; arrival: number }[] = [];
  private arrival = 0;
  private occ: OccurrenceAudit[] = [];
  private transitions: { from: BootstrapState; to: BootstrapState; reason: string }[] = [];
  private liveFrontier: LiveAcceptedFrontier | null = null;
  private handoff: HandoffWatermark | null = null;
  private recon: ReconciliationFrontier = { candidates: 0, last_source_event_ms: null };
  private lwm: number | null = null;
  private readonly archive: BootstrapSnapshot[] = [];
  private readonly allAudits: OccurrenceAudit[] = [];

  constructor(
    private readonly pipeline: FeedPipelinePort,
    private readonly identity: ObservationIdentityRegistry = new ObservationIdentityRegistry(),
  ) {}

  get state(): BootstrapState { return this._state; }
  get liveAcceptedFrontier(): LiveAcceptedFrontier | null { return this.liveFrontier; }
  get archivedSnapshots(): readonly BootstrapSnapshot[] { return this.archive; }
  get identityRegistry(): ObservationIdentityRegistry { return this.identity; }

  /** UNINITIALIZED (or a finished run) → BUFFERING_LIVE. A previous run is archived, never reset away. */
  start(epoch: number): void {
    if (this._state !== "UNINITIALIZED") {
      if (this._state !== "SYNCHRONIZED" && this._state !== "DEGRADED") throw new Error(`cannot restart during ${this._state}`);
      this.archive.push(this.snapshot());
      this.resetRun();
    }
    this.run++;
    this.activeEpoch = epoch;
    this.identity.identityStore.pin();
    this.go("BUFFERING_LIVE", `bootstrap run ${this.run} for epoch ${epoch}`);
  }

  /** LIVE arrival. Buffered during bootstrap; processed through identity → pipeline once SYNCHRONIZED. */
  onLive(o: ObservationOccurrence): void {
    if (o.delivery !== "LIVE") throw new Error("onLive requires delivery LIVE");
    switch (this._state) {
      case "UNINITIALIZED":
        throw new Error("live observation before bootstrap start");
      case "BUFFERING_LIVE":
      case "FETCHING_HISTORY":
      case "REPLAYING_HISTORY":
      case "DRAINING_BUFFER":
        if (this.activeEpoch !== null && o.connection_epoch > this.activeEpoch) {
          this.uncertainties.push(`EPOCH_CHANGED_DURING_BOOTSTRAP ${this.activeEpoch}→${o.connection_epoch}`);
        }
        this.buffer.push({ o, arrival: this.arrival++ });
        this.lwm = this.lwm === null ? o.source_event_ms : Math.min(this.lwm, o.source_event_ms);
        return;
      case "SYNCHRONIZED":
      case "DEGRADED": {
        // DEGRADED: still classified and audited; pipeline routing (and its own guards) still apply,
        // but the coordinator never claims synchronization.
        this.handle(o);
        return;
      }
    }
  }

  /** Explicit epoch change notification (e.g. from the client's reconnect). */
  onEpochChange(epoch: number): void {
    if (this.activeEpoch !== null && epoch === this.activeEpoch) return;
    if (this._state === "SYNCHRONIZED") {
      this.degrade(`EPOCH_ADVANCED ${this.activeEpoch}→${epoch}; re-bootstrap required`);
    } else if (this._state !== "UNINITIALIZED" && this._state !== "DEGRADED") {
      this.uncertainties.push(`EPOCH_CHANGED_DURING_BOOTSTRAP ${this.activeEpoch}→${epoch}`);
    }
  }

  beginHistory(request: BootstrapHistoryRequest): void {
    this.expect("BUFFERING_LIVE");
    this.history = Object.freeze({ request: Object.freeze({ ...request }), request_completed: false, coverage: null, market_coverage_proven_complete: false });
    this.go("FETCHING_HISTORY", `history requested [${request.requested_from}, ${request.requested_to}]`);
  }

  historyFailed(reason: string): void {
    this.expect("FETCHING_HISTORY");
    this.degrade(`HISTORY_FETCH_FAILED: ${reason}`);
  }

  /**
   * History arrived → REPLAYING_HISTORY → (auto) DRAINING_BUFFER → SYNCHRONIZED | DEGRADED.
   * Items must all be BACKFILL; they route via BACKFILL_HISTORY and never move the live frontier.
   */
  historyReceived(items: readonly ObservationOccurrence[], coverage: BootstrapHistoryCoverage): void {
    this.expect("FETCHING_HISTORY");
    this.history = Object.freeze({ ...this.history!, request_completed: true, coverage: Object.freeze({ ...coverage }) });
    this.historyReceivedCount = items.length;
    this.go("REPLAYING_HISTORY", `history request completed (${coverage.coverage_status}, ${coverage.returned_count} items)`);

    if (items.some((i) => i.delivery !== "BACKFILL")) {
      this.degrade("HISTORY_REPLAY_FAILED: history item not labelled BACKFILL (masquerade refused)");
      return;
    }
    const ordered = items
      .map((o, i) => ({ o, i }))
      .sort((a, b) => a.o.source_event_ms - b.o.source_event_ms || a.o.sequence - b.o.sequence || a.o.item_index - b.o.item_index || a.i - b.i);
    try {
      for (const { o } of ordered) {
        const a = this.handle(o);
        if (a.pipeline && a.pipeline.route === "LIVE_MUTATION") throw new Error("BACKFILL reached LIVE_MUTATION");
      }
    } catch (err) {
      this.degrade(`HISTORY_REPLAY_FAILED: ${(err as Error).message}`);
      return;
    }
    this.drain();
  }

  private drain(): void {
    this.go("DRAINING_BUFFER", `draining ${this.buffer.length} buffered LIVE observations`);
    const ordered = [...this.buffer].sort(
      (a, b) => a.o.source_event_ms - b.o.source_event_ms || a.o.connection_epoch - b.o.connection_epoch || a.o.sequence - b.o.sequence || a.arrival - b.arrival,
    );
    try {
      for (const { o } of ordered) {
        const a = this.handle(o);
        if (a.action === "HELD_RECONCILE") this.uncertainties.push(`UNRESOLVED_LIVE_COLLISION ${a.identity.observation_id}`);
        if (a.pipeline && (a.pipeline.route === "QUARANTINED" || a.pipeline.route === "RECONCILIATION_CANDIDATE")) {
          this.uncertainties.push(`HANDOFF_${a.pipeline.route} ${a.occurrence.raw_event_id}`);
        }
      }
    } catch (err) {
      this.degrade(`BUFFER_DRAIN_FAILED: ${(err as Error).message}`);
      return;
    }
    this.buffer = [];
    if (this.activeEpoch === null) return this.degrade("ACTIVE_EPOCH_UNKNOWN");
    if (this.uncertainties.length > 0) return this.degrade(`UNRESOLVED_HANDOFF_UNCERTAINTY: ${this.uncertainties.join("; ")}`);
    this.handoff = Object.freeze({
      live_frontier_at_handoff: this.liveFrontier,
      history_newest_returned_at: this.history?.coverage?.newest_returned_at ?? null,
    });
    this.identity.identityStore.unpin();
    this.go("SYNCHRONIZED", "history replayed, overlap classified, buffer drained, no unresolved uncertainty");
  }

  private handle(o: ObservationOccurrence): OccurrenceAudit {
    const identity = this.identity.classify(o, this.activeEpoch);
    let action: OccurrenceAction;
    switch (identity.dedup_class) {
      case "STALE_EPOCH_OCCURRENCE": action = "HELD_STALE_EPOCH"; break;
      case "EXACT_TRANSPORT_DUPLICATE": action = "SUPPRESSED_EXACT_DUPLICATE"; break;
      case "PROBABLE_SOURCE_DUPLICATE": {
        // LIVE vs earlier LIVE on another channel: unproven → explicit reconcile hold (not a drop).
        // LIVE vs BACKFILL: the BACKFILL copy never entered live state, so the LIVE occurrence is forwarded.
        const priorLive = o.delivery === "LIVE" && this.identity.audit.some(
          (e) => identity.related.includes(e.classification.observation_id) && e.occurrence.delivery === "LIVE");
        action = priorLive ? "HELD_RECONCILE" : "FORWARDED";
        break;
      }
      case "AMBIGUOUS_COLLISION": // preserved: uncertainty never deletes a market observation
      case "DISTINCT_OBSERVATION": action = "FORWARDED"; break;
    }
    let pipeline: AuditRecord | null = null;
    if (action === "FORWARDED") {
      pipeline = this.pipeline.process(toEnvelope(o));
      if (pipeline.route === "LIVE_MUTATION") {
        if (o.delivery !== "LIVE") throw new Error("non-LIVE occurrence produced LIVE_MUTATION");
        if (this.liveFrontier && pipeline.candidate.event_at < this.liveFrontier.event_at) throw new Error("live frontier regression");
        this.liveFrontier = Object.freeze({ event_at: pipeline.candidate.event_at, canonical_seq: pipeline.canonical_seq!, raw_event_id: o.raw_event_id });
      } else if (pipeline.route === "RECONCILIATION_CANDIDATE") {
        this.recon = Object.freeze({ candidates: this.recon.candidates + 1, last_source_event_ms: o.source_event_ms });
      }
    } else if (action === "HELD_RECONCILE") {
      this.recon = Object.freeze({ candidates: this.recon.candidates + 1, last_source_event_ms: o.source_event_ms });
    }
    const a = Object.freeze<OccurrenceAudit>({ phase: this._state, occurrence: o, identity, action, pipeline });
    this.occ.push(a);
    this.allAudits.push(a);
    return a;
  }

  get metrics(): DedupMetrics {
    const by: Record<DedupClass, number> = {
      EXACT_TRANSPORT_DUPLICATE: 0, PROBABLE_SOURCE_DUPLICATE: 0, AMBIGUOUS_COLLISION: 0, DISTINCT_OBSERVATION: 0, STALE_EPOCH_OCCURRENCE: 0,
    };
    for (const e of this.identity.audit) by[e.classification.dedup_class]++;
    const ambiguous_total = by.AMBIGUOUS_COLLISION;
    const ambiguous_audited = this.allAudits.filter((a) => a.identity.dedup_class === "AMBIGUOUS_COLLISION").length;
    return Object.freeze({ by_class: Object.freeze(by), ambiguous_total, ambiguous_audited, silent_ambiguous_drops: ambiguous_total - ambiguous_audited });
  }

  snapshot(): BootstrapSnapshot {
    const hwm = this.history?.coverage?.newest_returned_at ?? null;
    const relation: TemporalSeparation["relation"] =
      this.lwm === null || hwm === null ? "UNKNOWN" : this.lwm > hwm ? "SEPARATED" : "OVERLAPPING";
    return Object.freeze({
      run: this.run,
      state: this._state,
      active_epoch: this.activeEpoch,
      degraded_reason: this.degradedReason,
      uncertainties: Object.freeze([...this.uncertainties]),
      history: this.history,
      history_received: this.historyReceivedCount,
      buffered: Object.freeze(this.buffer.map((b) => b.o)),
      occurrences: Object.freeze([...this.occ]),
      separation: Object.freeze({ lwm: this.lwm, hwm, relation, loss_inferred: false as const }),
      live_frontier: this.liveFrontier,
      handoff: this.handoff,
      reconciliation: this.recon,
      transitions: Object.freeze([...this.transitions]),
    });
  }

  private degrade(reason: string): void {
    this.degradedReason = reason;
    this.go("DEGRADED", reason);
    // Fail-fast keeps an invalidated audit snapshot; buffered evidence is NOT discarded.
    this.archive.push(this.snapshot());
  }

  private resetRun(): void {
    this.degradedReason = null;
    this.uncertainties = [];
    this.history = null;
    this.historyReceivedCount = 0;
    this.buffer = [];
    this.occ = [];
    this.transitions = [];
    this.handoff = null;
    this.lwm = null;
    if (this.identity.identityStore.pinned) this.identity.identityStore.unpin();
  }

  private expect(s: BootstrapState): void {
    if (this._state !== s) throw new Error(`bootstrap expected ${s}, was ${this._state}`);
  }
  private go(to: BootstrapState, reason: string): void {
    this.transitions.push(Object.freeze({ from: this._state, to, reason }));
    this._state = to;
  }
}

/** Occurrence → existing 3.0A envelope (same mapping as GatewayMarketIngest). */
export function toEnvelope(o: ObservationOccurrence): BrokerEventEnvelope<RawBrokerTick> {
  return {
    raw: {
      raw_event_id: o.raw_event_id,
      symbol: o.broker_symbol,
      broker_time_ms: o.source_event_ms,
      bid: o.bid,
      ask: o.ask,
      last: o.last,
      volume: o.volume,
      flags: o.flags,
    },
    source: o.source,
    symbol: o.canonical_symbol,
    received_at: o.received_at,
    connection_epoch: o.connection_epoch,
    delivery: o.delivery === "LIVE" ? "STREAM" : "BACKFILL",
  };
}
