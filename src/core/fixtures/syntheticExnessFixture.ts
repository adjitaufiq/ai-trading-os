// SYNTHETIC Exness-like fixtures. None of these values (offset, point,
// latency, gaps) are claimed to be real Exness characteristics — TRS-03 will measure those.
import type { BrokerEventEnvelope, RawBrokerBar, RawBrokerTick, SymbolSpecification } from "../broker/types";
import type { DiscrepancyTolerance } from "../broker/DiscrepancyVerifier";

export const BROKER_T0 = Date.UTC(2026, 0, 5, 8, 0, 0);
const OFFSET = 2 * 60 * 60_000; // synthetic broker-server offset assumption

export const SYNTHETIC_SPEC: SymbolSpecification = Object.freeze({
  symbol: "XAUUSD",
  origin: "SYNTHETIC",
  digits: 2,
  point: 0.01,
  tick_size: 0.01,
  contract_size: 100,
  broker_utc_offset_ms: OFFSET,
});

export const SYNTHETIC_TOLERANCE: DiscrepancyTolerance = Object.freeze({
  maxPriceDeltaPoints: 5,
  maxTickVolumeDelta: 2,
  maxOpenTimeDeltaMs: 0,
});

export const SYNTHETIC_MAX_LATENCY_MS = 2_000;
export const SYNTHETIC_MAX_GAP_MS = 120_000;

interface TickOpts { recvSec?: number; epoch?: number; backfill?: boolean }
export function tick(id: string, eventSec: number, bid: number, o: TickOpts = {}): BrokerEventEnvelope<RawBrokerTick> {
  return Object.freeze({
    raw: Object.freeze({
      raw_event_id: id,
      symbol: "XAUUSD",
      broker_time_ms: BROKER_T0 + eventSec * 1000 + OFFSET,
      bid,
      ask: +(bid + 0.2).toFixed(2),
    }),
    source: "EXNESS_MT5",
    symbol: "XAUUSD",
    received_at: BROKER_T0 + Math.round((o.recvSec ?? eventSec + 0.02) * 1000),
    connection_epoch: o.epoch ?? 1,
    delivery: o.backfill ? "BACKFILL" : "STREAM",
  });
}

/** Delivery order (as the bridge would hand it over). Never sorted. */
export const anomalyEnvelopes: readonly BrokerEventEnvelope<RawBrokerTick>[] = Object.freeze([
  tick("t01", 0, 2345.1), // normal
  tick("t02", 60, 2345.5), // normal
  tick("t02", 60, 2345.5, { recvSec: 61 }), // DUPLICATE (same raw id)
  tick("t04", 180, 2345.8), // normal (arrives before t03)
  tick("t03", 120, 2344.0, { recvSec: 180.5 }), // OUT_OF_ORDER → QUARANTINE
  tick("t05", 250, 2345.9, { recvSec: 240 }), // TEMPORAL_INVALID (event after receipt) → REJECT
  tick("t06", 299, 2346.0, { recvSec: 304 }), // LATE_EVENT latency → ACCEPT_WITH_FLAG
  tick("t07", 310, 2346.4), // crosses boundary → bar 08:00 CLOSED
  tick("t08", 200, 2350.0, { recvSec: 315 }), // LATE_EVENT for CLOSED bar → QUARANTINE
  tick("t09", 520, 2346.9), // GAP (210s > 120s) → ACCEPT_WITH_FLAG
  tick("t10", 900, 2347.5, { epoch: 2 }), // RECONNECT_BACKFILL + GAP (multi-observation)
  tick("t11", 560, 2346.7, { recvSec: 905, epoch: 2, backfill: true }), // backfill into CLOSED bar → RECONCILE
]);

export function brokerBar(id: string, openSec: number, o: number, h: number, l: number, c: number, tv: number, recvSec: number): BrokerEventEnvelope<RawBrokerBar> {
  return Object.freeze({
    raw: Object.freeze({
      raw_event_id: id, symbol: "XAUUSD", timeframe: "M5" as const,
      open_time_broker_ms: BROKER_T0 + openSec * 1000 + OFFSET,
      open: o, high: h, low: l, close: c, tick_volume: tv, real_volume: null,
    }),
    source: "EXNESS_MT5", symbol: "XAUUSD",
    received_at: BROKER_T0 + recvSec * 1000, connection_epoch: 1, delivery: "STREAM",
  });
}

/** Broker bars for internal bar 08:00 (O 2345.10 H 2346.00 L 2345.10 C 2346.00 n4). */
export const brokerBarCases = Object.freeze({
  exact: brokerBar("b-exact", 0, 2345.1, 2346.0, 2345.1, 2346.0, 4, 301),
  small: brokerBar("b-small", 0, 2345.1, 2346.0, 2345.1, 2346.02, 5, 301),
  material: brokerBar("b-material", 0, 2345.1, 2347.0, 2345.1, 2346.0, 4, 301),
  /** Broker has a bar where internal has none (08:10 bucket had no accepted ticks). */
  orphan: brokerBar("b-orphan", 600, 2347.0, 2347.2, 2346.8, 2347.1, 3, 901),
});
