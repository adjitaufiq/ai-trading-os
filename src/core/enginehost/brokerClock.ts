// Broker-anchored clock monitor (pure). Timestamp priority: broker_time (MT5 event_at, offset-normalized) →
// bar/tick timestamp → VPS receive time. It only OBSERVES drift: it never rewrites candle timestamps and never
// forces a correction. Candle lifecycle keeps using event_at via CandleAggregator.
import type { BrokerMarketEvent } from "../broker/types";

export const BROKER_CLOCK_POLICY = Object.freeze({
  /** |vps_receive_time − broker_time| above this ⇒ DRIFT_WARNING (operator policy, not broker-measured). */
  drift_warning_ms: 3_000,
});

export type ClockStatus = "NORMAL" | "DRIFT_WARNING" | "UNKNOWN";

export interface BrokerClockView {
  readonly broker_time: string | null;
  readonly vps_receive_time: string | null;
  readonly clock_drift_ms: number | null;
  readonly status: ClockStatus;
  readonly timestamp_source: "BROKER_TIME" | "NONE";
}

const iso = (ms: number) => new Date(ms).toISOString();

export function deriveBrokerClock(live: Pick<BrokerMarketEvent, "event_at" | "observed_at"> | null, p = BROKER_CLOCK_POLICY): BrokerClockView {
  if (!live) return Object.freeze({ broker_time: null, vps_receive_time: null, clock_drift_ms: null, status: "UNKNOWN", timestamp_source: "NONE" });
  const drift = live.observed_at - live.event_at;
  return Object.freeze({
    broker_time: iso(live.event_at), vps_receive_time: iso(live.observed_at), clock_drift_ms: drift,
    status: Math.abs(drift) > p.drift_warning_ms ? "DRIFT_WARNING" : "NORMAL", timestamp_source: "BROKER_TIME",
  });
}
