// Pure engine-health derivation from runtime evidence. No UI assumptions, no clock reads (now is injected).
import type { MarketRuntimeReader } from "../runtime/MarketRuntime";
import type { EngineState, SymbolEngineHealth } from "./types";

/** Documented host policy (operator configuration, not broker-measured values). */
export const ENGINE_HEALTH_POLICY = Object.freeze({
  /** No LIVE observation for this long while RUNNING ⇒ DEGRADED (STALE_FEED). Markets can be closed; this is surfaced, not hidden. */
  stale_feed_ms: 120_000,
});

export function deriveSymbolHealth(i: {
  symbol: string; reader: MarketRuntimeReader | null; mount_status: string; restarts: number; now: number;
}, p = ENGINE_HEALTH_POLICY): SymbolEngineHealth {
  const r = i.reader;
  if (!r) {
    // INIT / RESOLVING_SPEC = still starting; any other unmounted status is a real failure reason from the mount.
    const starting = i.mount_status === "INIT" || i.mount_status === "RESOLVING_SPEC";
    return Object.freeze({ symbol: i.symbol, state: starting ? "STARTING" : "OFFLINE", last_update_at: null, latency_ms: null, error: starting ? null : i.mount_status, radar_status: "NOT_MOUNTED", mount_status: i.mount_status, restarts: i.restarts });
  }
  const snap = r.snapshot();
  const live = r.latestLiveObservation();
  const radar = r.radarHealth();
  const last = live ? live.observed_at : null;
  const latency = live ? live.observed_at - live.event_at : null;
  let state: EngineState;
  let error: string | null = null;
  if (snap.lifecycle === "STOPPED") { state = "OFFLINE"; error = snap.degraded_reason ?? "RUNTIME_STOPPED"; }
  else if (snap.bootstrap_state === "DEGRADED") { state = "DEGRADED"; error = snap.degraded_reason ?? "BOOTSTRAP_DEGRADED"; }
  else if (snap.lifecycle !== "RUNNING" || snap.bootstrap_state !== "SYNCHRONIZED" || radar.status === "INITIALIZING") state = "SYNCING";
  else if (last === null || i.now - last > p.stale_feed_ms) { state = "DEGRADED"; error = "STALE_FEED"; }
  else if (radar.status === "ERROR") { state = "DEGRADED"; error = radar.lastError ?? "RADAR_ERROR"; }
  else state = "ONLINE";
  if (!error && snap.last_stream_error && state !== "ONLINE") error = snap.last_stream_error;
  return Object.freeze({ symbol: i.symbol, state, last_update_at: last, latency_ms: latency, error, radar_status: radar.status, mount_status: i.mount_status, restarts: i.restarts });
}
