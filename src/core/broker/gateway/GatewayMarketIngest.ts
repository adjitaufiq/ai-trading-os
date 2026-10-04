// Gateway observation → Stage 3.0A BrokerFeedPipeline. This is the ONLY path from the gateway
// toward a CandleAggregator: the pipeline's normalizer + anomaly classifier always run first.
import type { AuditRecord, BrokerFeedPipeline } from "../BrokerFeedPipeline";
import type { BrokerEventEnvelope, RawBrokerTick } from "../types";
import type { ClientTickObservation } from "./types";

export interface GatewaySymbolBinding {
  /** Explicit, already-resolved binding. The ingest never guesses a symbol mapping. */
  readonly broker_symbol: string;
  readonly canonical_symbol: string;
}

export type IngestOutcome =
  | { readonly status: "FORWARDED"; readonly record: AuditRecord }
  | { readonly status: "HELD"; readonly reason: "SEQUENCE_QUARANTINE" | "SYMBOL_NOT_BOUND" };

export interface IngestTrace {
  readonly observation: ClientTickObservation;
  readonly outcome: IngestOutcome;
  readonly audit: AuditRecord | undefined;
}

export class GatewayMarketIngest {
  private readonly held: { observation: ClientTickObservation; outcome: IngestOutcome }[] = [];
  private readonly byId = new Map<string, { observation: ClientTickObservation; outcome: IngestOutcome }>();

  constructor(
    private readonly pipeline: BrokerFeedPipeline,
    private readonly binding: GatewaySymbolBinding,
  ) {}

  ingest(o: ClientTickObservation): IngestOutcome {
    let outcome: IngestOutcome;
    if (o.sequence_disposition === "QUARANTINE") {
      outcome = Object.freeze({ status: "HELD", reason: "SEQUENCE_QUARANTINE" });
    } else if (o.tick.broker_symbol !== this.binding.broker_symbol) {
      outcome = Object.freeze({ status: "HELD", reason: "SYMBOL_NOT_BOUND" });
    } else {
      const env: BrokerEventEnvelope<RawBrokerTick> = {
        raw: {
          raw_event_id: o.raw_event_id,
          symbol: o.tick.broker_symbol,
          broker_time_ms: o.tick.raw_time_msc,
          bid: o.tick.bid,
          ask: o.tick.ask,
          last: o.tick.last,
          volume: o.tick.volume,
          flags: o.tick.flags,
        },
        source: o.source,
        symbol: this.binding.canonical_symbol,
        received_at: o.bridge_timing.bridge_received_at,
        connection_epoch: o.connection_epoch,
        delivery: o.delivery === "LIVE" ? "STREAM" : "BACKFILL",
      };
      outcome = Object.freeze({ status: "FORWARDED", record: this.pipeline.process(env) });
    }
    const entry = { observation: o, outcome };
    this.byId.set(o.raw_event_id, entry);
    if (outcome.status === "HELD") this.held.push(entry);
    return outcome;
  }

  get heldObservations(): readonly { observation: ClientTickObservation; outcome: IngestOutcome }[] {
    return this.held;
  }

  /** native observation → bridge envelope → client observation → MarketEvent (audit). */
  trace(raw_event_id: string): IngestTrace | undefined {
    const e = this.byId.get(raw_event_id);
    if (!e) return undefined;
    return { ...e, audit: this.pipeline.trace(raw_event_id) };
  }
}
