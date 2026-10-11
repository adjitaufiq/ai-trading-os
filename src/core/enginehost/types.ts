// Engine Host read model (engine-host-v1). Read-only: the host exposes GET routes only; no order/execution surface exists.
import type { RadarHealth, RadarSnapshot } from "../radar/types";
import type { VirtualAccountView } from "../paper/LivePaperLoop";
import type { JournalTrade } from "../../engine/journal/types";
import type { BrokerClockView } from "./brokerClock";

export const ENGINE_HOST_SCHEMA = "engine-host-v1" as const;

/** Stable lifecycle. Transitions only move along real evidence; never inferred by the UI. */
/** BOOTSTRAP = runtime running but closed-history baseline (ATR/volatility/radar) not ready yet; no defaults are shown. */
export type EngineState = "STARTING" | "BOOTSTRAP" | "SYNCING" | "ONLINE" | "DEGRADED" | "OFFLINE";

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
  /** Broker-anchored clock drift monitor (observational only). */
  readonly clock: BrokerClockView;
}

export interface EngineHostHealth {
  /** DEMO only when the demo path is armed; REAL account stays absent. */
  readonly operating_mode: "MONITOR_ONLY" | "DEMO";
  /** true only when demo path armed AND shadow off AND no kill switch active (observation, not a gate). */
  readonly execution_enabled: boolean;
  readonly started_at: number;
  readonly persistence: "VPS_DISK";
  /** Stage 10 demo lab mode. MONITOR_ONLY/execution_enabled describe the REAL account, which stays absent. */
  readonly demo_execution?: "REAL_DISABLED" | "PAPER_ONLY" | "DEMO_STRESS_TEST";
  readonly symbols: readonly SymbolEngineHealth[];
  /** Which code is actually running (engine_version, commit, build_time, status). Absent on older hosts. */
  readonly build?: import("./buildInfo").EngineBuildInfo;
  /** Shadow Guard status (Phase 2A). Absent on older hosts. */
  readonly shadow?: unknown;
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

/** UI ownership tag (Phase 2.1). Every payload a dashboard view renders carries exactly one; mixing is an error. */
export type UiDataSource = "ENGINE_HOST" | "BROWSER_SESSION";

/** Minimal live-quote facts a view needs (no raw evidence objects cross the wire). */
export interface LiveQuoteFacts { readonly source: string; readonly bid: number; readonly ask: number; readonly event_at: number; readonly observed_at: number }

/** One symbol's complete read model as served by the engine host (GET /v1/engine/:symbol/snapshot, SSE SNAPSHOT_UPDATE). */
export interface EngineSymbolBundle {
  readonly symbol: string;
  readonly source: "ENGINE_HOST";
  readonly timestamp: number;
  readonly health: SymbolEngineHealth | null;
  /** Technical slice view (SliceView) computed on the VPS; null until the runtime is mounted. */
  readonly slice: Readonly<import("../technical/TechnicalSliceService").SliceView> | null;
  readonly radar: EngineRadarView;
  readonly account: EngineAccountView;
  readonly trades: EngineJournalView;
  readonly live: LiveQuoteFacts | null;
  readonly last_m5_close: number | null;
}
