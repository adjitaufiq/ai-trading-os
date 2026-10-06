// Radar read model (radar-v1). Authority NONE: descriptive dashboard view of M1B.8–M1B.11 state.
// No confidence/probability/score fields exist by design.
import type { AssetClass } from "../broker/types";
import type { MarketSession } from "../temporal/MarketSessionResolver";
import type { EventSeverity, EventState, MarketEventType } from "../../engine/core/market/events/types";
import type { MarketApproach, TradingHorizon } from "../../engine/core/market/horizon/types";
import type { MarketRegimeType } from "../../engine/core/market/regime/types";

export const RADAR_SCHEMA_VERSION = "radar-v1" as const;
export const RADAR_RECENT_EVENTS_MAX = 20;
/** ACTIVE becomes STALE when no M5 close was evaluated for this long (2 × M5). */
export const RADAR_STALE_AFTER_MS = 10 * 60_000;

export interface RadarHealth {
  readonly status: "INITIALIZING" | "ACTIVE" | "STALE" | "ERROR";
  readonly lastSuccessfulEvaluation: number;
  readonly validationMode: "SYNTHETIC" | "REAL";
  readonly lastError?: string;
}

export interface ValidationSource {
  readonly mode: "SYNTHETIC" | "REAL";
  readonly provider?: string;
  readonly feedId?: string;
  readonly evaluatedAt: number;
}

export type RadarFootprintTag = "LIQUIDITY_SWEEP" | "DISPLACEMENT" | "FVG_ACTIVE" | "FVG_MITIGATED" | "ORDER_BLOCK_ACTIVE";

export interface RadarEventReference {
  readonly eventId: string;
  readonly type: MarketEventType;
  readonly severity: EventSeverity;
  readonly state: EventState;
  readonly timeframe: string | null;
  readonly startedAt: number;
  readonly ageBars: number;
}

export interface AlgorithmVersions {
  readonly footprint: string;
  readonly regime: string;
  readonly horizon: string;
  readonly events: string;
}

export type RadarH1Phase = "BULLISH" | "BEARISH" | "PULLBACK" | "EXPANSION" | "CHOP" | "TRANSITION";

export interface RadarSnapshot {
  readonly schemaVersion: typeof RADAR_SCHEMA_VERSION;
  readonly symbol: string;
  readonly assetClass: AssetClass | null;
  readonly session: MarketSession | null;
  /** close_time (UTC ms) of the CLOSED M5 bar that produced this snapshot. */
  readonly lastEvaluatedBarTime: number;
  readonly health: RadarHealth;
  readonly regime: { readonly type: MarketRegimeType; readonly evidence: readonly string[]; readonly h4Bias: "BULLISH" | "BEARISH" | "NEUTRAL"; readonly h1Phase: RadarH1Phase };
  readonly horizon: { readonly compatibleHorizons: readonly TradingHorizon[]; readonly marketApproach: MarketApproach; readonly vetoReason: string | null };
  readonly footprints: {
    readonly activeTags: readonly RadarFootprintTag[];
    readonly lastSweep?: { readonly direction: "BULLISH" | "BEARISH"; readonly level: number; readonly timestamp: number };
    readonly activeFVGsCount: number;
    readonly activeOrderBlocksCount: number;
  };
  readonly activeEvents: readonly RadarEventReference[];
  readonly recentEvents: readonly RadarEventReference[];
  readonly validationSource: ValidationSource;
  readonly algorithmVersions: AlgorithmVersions;
  readonly generatedAt: number;
}
