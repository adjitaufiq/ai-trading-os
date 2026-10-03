import type { CanonicalClock } from "../temporal/CanonicalClock";
import type {
  BrokerEventEnvelope,
  BrokerMarketEvent,
  NormalizedBrokerBar,
  Provenance,
  RawBrokerBar,
  RawBrokerTick,
  SymbolSpecification,
} from "./types";

export const NORMALIZER_VERSION = "3.0A-synthetic-1";

function provenance(env: BrokerEventEnvelope<{ raw_event_id: string }>): Provenance {
  return Object.freeze({
    raw_event_id: env.raw.raw_event_id,
    source: env.source,
    symbol: env.symbol,
    received_at: env.received_at,
    normalizer_version: NORMALIZER_VERSION,
    connection_epoch: env.connection_epoch,
    delivery: env.delivery,
  });
}

/**
 * Pure translation raw → canonical candidate. Does NOT validate or repair;
 * that is the classifier's job. seq is assigned by the pipeline on acceptance.
 */
export class BrokerNormalizer {
  constructor(
    private readonly spec: SymbolSpecification,
    private readonly clock: CanonicalClock,
  ) {}

  normalizeTick(env: BrokerEventEnvelope<RawBrokerTick>, seq: number): BrokerMarketEvent {
    const r = env.raw;
    return Object.freeze<BrokerMarketEvent>({
      seq,
      symbol: env.symbol,
      source: "EXNESS_MT5",
      bid: r.bid,
      ask: r.ask,
      spread: +(r.ask - r.bid).toFixed(this.spec.digits),
      event_at: r.broker_time_ms - this.spec.broker_utc_offset_ms,
      observed_at: env.received_at,
      ingested_at: this.clock.now(),
      provenance: provenance(env),
    });
  }

  normalizeBar(env: BrokerEventEnvelope<RawBrokerBar>): NormalizedBrokerBar {
    const r = env.raw;
    return Object.freeze<NormalizedBrokerBar>({
      symbol: env.symbol,
      timeframe: r.timeframe,
      open_time: r.open_time_broker_ms - this.spec.broker_utc_offset_ms,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      tick_volume: r.tick_volume,
      real_volume: r.real_volume,
      observed_at: env.received_at,
      provenance: provenance(env),
    });
  }
}
