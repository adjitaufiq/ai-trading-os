// Radar read-model composer. Runs the EXISTING M1B.3/5/6/8/9/10/11 engines on CLOSED canonical bars only and
// freezes a RadarSnapshot. Authority NONE: never imports signal/plan/risk/execution, never emits orders.
import type { Bar, Timeframe } from "../contracts";
import { defaultSymbolRegistry } from "../broker/SymbolRegistry";
import { resolveMarketSession } from "../temporal/MarketSessionResolver";
import { computeEMAContext } from "../../engine/core/ema/emaStateEngine";
import { computeAtr } from "../../engine/core/location/priceLocationEngine";
import { MarketEventEngine } from "../../engine/core/market/events/eventEngine";
import { EVENT_ALGORITHM_VERSION, type MarketEvent } from "../../engine/core/market/events/types";
import { classifyHorizon } from "../../engine/core/market/horizon/horizonClassifier";
import { HORIZON_ALGORITHM_VERSION, type M5MomentumObservation } from "../../engine/core/market/horizon/types";
import { trackFVGs } from "../../engine/core/market/institutional-radar/fvgTracker";
import { scanInstitutionalFootprints } from "../../engine/core/market/institutional-radar/institutionalRadar";
import { detectOrderBlocks } from "../../engine/core/market/institutional-radar/orderBlockDetector";
import { INSTITUTIONAL_RADAR_POLICY_VERSION } from "../../engine/core/market/institutional-radar/types";
import { classifyRegime } from "../../engine/core/market/regime/regimeClassifier";
import { REGIME_ALGORITHM_VERSION } from "../../engine/core/market/regime/types";
import type { ArenaCandle } from "../../engine/core/normalizer/types";
import { buildStructure, detectStructureShift } from "../../engine/core/swing/structureEngine";
import { SwingDetector } from "../../engine/core/swing/swingDetector";
import type { MarketStructure, SwingTimeframe } from "../../engine/core/swing/types";
import {
  RADAR_RECENT_EVENTS_MAX, RADAR_SCHEMA_VERSION, RADAR_STALE_AFTER_MS,
  type AlgorithmVersions, type RadarEventReference, type RadarFootprintTag, type RadarH1Phase, type RadarHealth, type RadarSnapshot,
} from "./types";

export const RADAR_ALGORITHM_VERSIONS: AlgorithmVersions = Object.freeze({
  footprint: INSTITUTIONAL_RADAR_POLICY_VERSION, regime: REGIME_ALGORITHM_VERSION, horizon: HORIZON_ALGORITHM_VERSION, events: EVENT_ALGORITHM_VERSION,
});

const MIN_M15_BARS = 15;
const ATR_HISTORY = 200;

export interface RadarSourceInfo { readonly mode: "SYNTHETIC" | "REAL"; readonly provider?: string; readonly feedId?: string }

const toArena = (b: Bar, i: number): ArenaCandle => Object.freeze({
  id: `${b.symbol}_${b.timeframe}_${b.open_time / 1000}`, symbol: b.symbol, timeframe: b.timeframe, timestamp: b.open_time / 1000,
  open: b.open, high: b.high, low: b.low, close: b.close, volume: b.tick_count, spread: 0, source: "MT5", isClosed: true, sequence: i + 1,
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

export class RadarRuntimeService {
  private readonly events = new MarketEventEngine();
  private readonly atrHistory: number[] = [];
  private readonly recent: RadarEventReference[] = [];
  private snap: Readonly<RadarSnapshot> | null = null;
  private lastOk = 0;
  private lastBarClose = -Infinity;
  private error: string | null = null;
  /** Number of completed evaluations (one per accepted CLOSED M5 bar). */
  evaluations = 0;

  constructor(readonly symbol: string, private readonly source: RadarSourceInfo) {}

  snapshot(): Readonly<RadarSnapshot> | null { return this.snap; }

  health(nowMs: number): Readonly<RadarHealth> {
    const base = { lastSuccessfulEvaluation: this.lastOk, validationMode: this.source.mode };
    if (this.error) return Object.freeze({ status: "ERROR", ...base, lastError: this.error });
    if (!this.snap) return Object.freeze({ status: "INITIALIZING", ...base });
    return Object.freeze({ status: nowMs - this.lastOk > RADAR_STALE_AFTER_MS ? "STALE" : "ACTIVE", ...base });
  }

  /** Call only with a CLOSED M5 bar. Forming bars and replays of an already-evaluated close are ignored. */
  onClosedM5(bar: Bar, closed: (tf: Timeframe) => readonly Bar[], nowMs: number): void {
    if (bar.status !== "CLOSED" || bar.timeframe !== "M5" || bar.symbol !== this.symbol || bar.close_time <= this.lastBarClose) return;
    this.lastBarClose = bar.close_time;
    try {
      this.evaluate(bar, closed, nowMs);
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  private evaluate(bar: Bar, closed: (tf: Timeframe) => readonly Bar[], nowMs: number): void {
    const sym = this.symbol;
    const now = bar.close_time / 1000;
    const visible = (tf: Timeframe) => closed(tf).filter((b) => b.status === "CLOSED" && b.close_time <= bar.close_time).map(toArena);
    const m5 = visible("M5"), m15 = visible("M15");
    if (m15.length < MIN_M15_BARS) return; // INITIALIZING: not enough closed evidence, nothing fabricated
    const structure = (tf: SwingTimeframe): MarketStructure => {
      const det = new SwingDetector(sym, tf);
      for (const c of tf === "M15" ? m15 : visible(tf)) det.push(c);
      return buildStructure(sym, tf, det.getSwings(), now);
    };
    const m15S = detectStructureShift(structure("M15"), m15.at(-1)!);
    const h4S = structure("H4"), h1S = structure("H1");
    const atr = computeAtr(m15);
    if (atr === null) return;
    const regime = classifyRegime({ symbol: sym, now, h4Structure: h4S, h1Structure: h1S, m15Atr: atr, historicalAtrList: [...this.atrHistory] });
    this.atrHistory.push(atr); if (this.atrHistory.length > ATR_HISTORY) this.atrHistory.shift();
    const footprints = scanInstitutionalFootprints({ candles: m15, structure: m15S, atr14M15: atr });
    const ema = computeEMAContext(m5, now);
    const momentum: M5MomentumObservation = !ema.ok ? "UNAVAILABLE" : ema.context.slope21 === "RISING" ? "BULLISH" : ema.context.slope21 === "FALLING" ? "BEARISH" : "NONE";
    const horizon = classifyHorizon({ symbol: sym, now, regime, m15Structure: m15S, m5Momentum: momentum, footprints });
    const revs = this.events.step({ symbol: sym, timeframe: "M5", barTime: now, regime, horizon, footprints, footprintTimeframe: "M15", snrInteractions: [], reactionConfirmed: false });

    const ref = (e: MarketEvent): RadarEventReference => ({
      eventId: e.eventId, type: e.type, severity: e.severity, state: e.state, timeframe: e.timeframe,
      startedAt: e.createdAt * 1000, ageBars: Math.max(0, Math.floor((now - e.createdAt) / 300)),
    });
    for (const e of revs) { this.recent.push(ref(e)); if (this.recent.length > RADAR_RECENT_EVENTS_MAX) this.recent.shift(); }

    const fvgs = trackFVGs(m15);
    const obs = detectOrderBlocks(m15, m15S, atr).filter((o) => (o as { status?: string }).status !== "INVALIDATED");
    const activeFVGs = fvgs.filter((f) => f.status === "ACTIVE").length;
    const tags: RadarFootprintTag[] = [];
    if (footprints.sweepDetected) tags.push("LIQUIDITY_SWEEP");
    if (footprints.displacementPreceded) tags.push("DISPLACEMENT");
    if (activeFVGs > 0) tags.push("FVG_ACTIVE");
    if (fvgs.some((f) => f.status === "MITIGATED")) tags.push("FVG_MITIGATED");
    if (obs.length > 0) tags.push("ORDER_BLOCK_ACTIVE");
    const sweptLevel = footprints.sweepDirection === "BULLISH" ? m15S.lastConfirmedLow?.price : m15S.lastConfirmedHigh?.price;
    const sweepBar = footprints.sweepAgeBars >= 0 ? m15[m15.length - 1 - footprints.sweepAgeBars] : undefined;

    const h4Bias = h4S.trend === "HH_HL" ? "BULLISH" : h4S.trend === "LH_LL" ? "BEARISH" : "NEUTRAL";
    const h1Trend = h1S.trend === "HH_HL" ? "BULLISH" : h1S.trend === "LH_LL" ? "BEARISH" : "NEUTRAL";
    const h1Phase: RadarH1Phase = regime.regime === "VOLATILITY_EXPANSION" ? "EXPANSION"
      : h1S.shiftDetected || regime.regime === "TRANSITION" ? "TRANSITION"
      : h1Trend === "NEUTRAL" ? "CHOP"
      : h4Bias !== "NEUTRAL" && h1Trend !== h4Bias ? "PULLBACK" : h1Trend;
    const assetClass = defaultSymbolRegistry.get(sym)?.assetClass ?? null;

    this.lastOk = nowMs;
    this.evaluations++;
    this.snap = deepFreeze<RadarSnapshot>({
      schemaVersion: RADAR_SCHEMA_VERSION, symbol: sym, assetClass,
      session: assetClass ? resolveMarketSession(bar.open_time, assetClass) : null,
      lastEvaluatedBarTime: bar.close_time,
      health: { status: "ACTIVE", lastSuccessfulEvaluation: nowMs, validationMode: this.source.mode },
      regime: { type: regime.regime, evidence: [...regime.evidence], h4Bias, h1Phase },
      horizon: {
        compatibleHorizons: [...horizon.compatibleHorizons], marketApproach: horizon.marketApproach,
        vetoReason: horizon.recommendedHorizon === "NO_FIT" ? horizon.evidence[0] ?? "NO_COMPATIBLE_HORIZON" : null,
      },
      footprints: {
        activeTags: tags,
        ...(footprints.sweepDetected && footprints.sweepDirection && sweptLevel !== undefined && sweepBar
          ? { lastSweep: { direction: footprints.sweepDirection, level: sweptLevel, timestamp: sweepBar.timestamp * 1000 } } : {}),
        activeFVGsCount: activeFVGs, activeOrderBlocksCount: obs.length,
      },
      activeEvents: this.events.store.getActiveEvents(sym).map(ref),
      recentEvents: [...this.recent],
      validationSource: { mode: this.source.mode, ...(this.source.provider ? { provider: this.source.provider } : {}), ...(this.source.feedId ? { feedId: this.source.feedId } : {}), evaluatedAt: nowMs },
      algorithmVersions: { ...RADAR_ALGORITHM_VERSIONS },
      generatedAt: nowMs,
    });
  }
}
