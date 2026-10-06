// Engine Host read model (engine-host-v1). Read-only: the host exposes GET routes only; no order/execution surface exists.
import type { RadarHealth, RadarSnapshot } from "../radar/types";
import type { VirtualAccountView } from "../paper/LivePaperLoop";
import type { JournalTrade } from "../../engine/journal/types";

export const ENGINE_HOST_SCHEMA = "engine-host-v1" as const;

/** Stable lifecycle. Transitions only move along real evidence; never inferred by the UI. */
export type EngineState = "STARTING" | "SYNCING" | "ONLINE" | "DEGRADED" | "OFFLINE";

export interface SymbolEngineHealth {
  readonly symbol: string;
  readonly state: EngineState;
  /** Wall time of the latest LIVE_MUTATION observation received by this runtime (null = none yet). */
  readonly last_update_at: number | null;
  /** observed_at − event_at of the latest LIVE observation, ms (null = unknown). */
  readonly latency_ms: number | null;
  readonly error: string | null;
  readonly radar_status: RadarHealth["status"] | "NOT_MOUNTED";
  readonly mount_status: string;
  readonly restarts: number;
}

export interface EngineHostHealth {
  readonly operating_mode: "MONITOR_ONLY";
  readonly execution_enabled: false;
  readonly started_at: number;
  readonly persistence: "VPS_DISK";
  readonly symbols: readonly SymbolEngineHealth[];
}

export interface EngineRadarView { readonly snapshot: Readonly<RadarSnapshot> | null; readonly health: Readonly<RadarHealth> | null }

export interface EngineEnvelope<T> {
  readonly schema: typeof ENGINE_HOST_SCHEMA;
  readonly source: "ENGINE_HOST";
  readonly generated_at: number;
  readonly data: T;
}

export type EngineAccountView = Readonly<VirtualAccountView> | null;
export type EngineJournalView = readonly Readonly<JournalTrade>[];
