// PRE-2D Patch C — R5 Missing Interval Contract.
// A missing interval is an object of UNCERTAINTY, never a candle. Nothing here produces OHLC.
// Feed state, observation coverage and candle lifecycle are three orthogonal axes (R5.2).
import { TIMEFRAME_MS, type Bar, type Timeframe } from "../contracts";

/** Why an interval has no canonical candle. Never asserts broker failure without proof (R5.3). */
export type MissingIntervalReason =
  | "NO_OBSERVATIONS_RECEIVED" // we hold none; cause unproven
  | "MARKET_CLOSED_PER_SESSION_CONTRACT" // only when an authoritative session contract says so
  | "OUTSIDE_SESSION_CONTRACT_UNRESOLVED" // no authoritative session contract → honest uncertainty
  | "BOOTSTRAP_HISTORY_LIMITATION"
  | "TRANSPORT_LOSS_SUSPECTED" // only with explicit transport evidence (e.g. SEQUENCE_GAP)
  | "UNKNOWN";

/** Axis 1 — feed. */
export type FeedAxis = "UNINITIALIZED" | "BOOTSTRAPPING" | "SYNCHRONIZED" | "DEGRADED" | "UNKNOWN";
/** Axis 2 — observation coverage for an interval/range. */
export type CoverageAxis = "OBSERVED" | "MISSING" | "CONTINUITY_UNPROVEN" | "UNKNOWN";
/** Axis 3 — candle lifecycle. NONE = no candle exists (a missing interval). */
export type LifecycleAxis = "FORMING" | "CLOSED" | "NONE";

export interface MissingInterval {
  readonly kind: "MISSING_INTERVAL";
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** [open_time, close_time) UTC epoch ms — same semantics as Bar. */
  readonly open_time: number;
  readonly close_time: number;
  /** Canonical clock time of detection. */
  readonly detected_at: number;
  readonly reason: MissingIntervalReason;
  readonly lifecycle: "NONE";
  readonly coverage: "MISSING";
  readonly source_context: string;
  readonly coverage_context: string;
  readonly provenance: { readonly detector: "MissingIntervalDetector"; readonly detector_version: string };
  /** Explicitly false: no OHLC exists for this object. */
  readonly has_ohlc: false;
}

/**
 * Session authority. Stage 3 ships NO authoritative session contract for XAUUSD/BTCUSD (no
 * hardcoded forex hours, no DST guesses). UNKNOWN_SESSION_CONTRACT makes uncertainty explicit.
 */
export interface SessionContract {
  readonly authoritative: boolean;
  /** Only consulted when authoritative. true = market closed for the whole interval. */
  isClosed(open_time: number, close_time: number): boolean;
}
export const UNKNOWN_SESSION_CONTRACT: SessionContract = Object.freeze({ authoritative: false, isClosed: () => false });

export const MISSING_INTERVAL_DETECTOR_VERSION = "R5-v1";

export interface DetectContext {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly detected_at: number;
  readonly session?: SessionContract;
  readonly source_context?: string;
  /** e.g. "bootstrap history count-based"; propagated, never upgraded to proof. */
  readonly coverage_context?: string;
  /** Set when transport evidence (e.g. SEQUENCE_GAP) exists for this range. */
  readonly transportLossEvidence?: boolean;
  readonly bootstrapLimited?: boolean;
}

function reasonFor(ctx: DetectContext, open: number, close: number): MissingIntervalReason {
  const s = ctx.session ?? UNKNOWN_SESSION_CONTRACT;
  if (s.authoritative && s.isClosed(open, close)) return "MARKET_CLOSED_PER_SESSION_CONTRACT";
  if (ctx.transportLossEvidence) return "TRANSPORT_LOSS_SUSPECTED";
  if (ctx.bootstrapLimited) return "BOOTSTRAP_HISTORY_LIMITATION";
  if (!s.authoritative) return "OUTSIDE_SESSION_CONTRACT_UNRESOLVED";
  return "NO_OBSERVATIONS_RECEIVED";
}

/**
 * Pure detector over CLOSED canonical candles within [from, to). Emits a MissingInterval for every
 * expected interval without a candle. Never returns, edits or creates Bars.
 */
export function detectMissingIntervals(closed: readonly Bar[], from: number, to: number, ctx: DetectContext): readonly MissingInterval[] {
  const tf = TIMEFRAME_MS[ctx.timeframe];
  const have = new Set(closed.filter((b) => b.symbol === ctx.symbol && b.timeframe === ctx.timeframe).map((b) => b.open_time));
  const out: MissingInterval[] = [];
  for (let t = Math.ceil(from / tf) * tf; t + tf <= to; t += tf) {
    if (have.has(t)) continue;
    out.push(Object.freeze<MissingInterval>({
      kind: "MISSING_INTERVAL", symbol: ctx.symbol, timeframe: ctx.timeframe, open_time: t, close_time: t + tf,
      detected_at: ctx.detected_at, reason: reasonFor(ctx, t, t + tf), lifecycle: "NONE", coverage: "MISSING",
      source_context: ctx.source_context ?? "canonical CLOSED candles", coverage_context: ctx.coverage_context ?? "internal observation coverage",
      provenance: Object.freeze({ detector: "MissingIntervalDetector", detector_version: MISSING_INTERVAL_DETECTOR_VERSION }),
      has_ohlc: false,
    }));
  }
  return Object.freeze(out);
}

/** A missing interval is NOT a broker failure unless an authoritative contract proves an observation was expected. */
export function impliesBrokerFailure(_m: MissingInterval): false {
  return false;
}

// ---------- R5.6 count-based history ----------

export interface CountBasedHistoryAssessment {
  readonly request_completed: boolean;
  readonly returned_count: number;
  readonly requested_count: number;
  /** Count-based retrieval never proves continuity of an arbitrary market interval. */
  readonly market_interval_complete: false;
  readonly coverage: CoverageAxis;
  readonly reason: string;
}

export function assessCountBasedHistory(requested_count: number, returned_count: number): CountBasedHistoryAssessment {
  return Object.freeze({
    request_completed: true,
    requested_count,
    returned_count,
    market_interval_complete: false,
    coverage: "CONTINUITY_UNPROVEN",
    reason: returned_count === requested_count
      ? "returned_count == requested_count proves request completion only, not continuous market coverage"
      : "fewer bars than requested; continuity unproven",
  });
}

// ---------- R5.5 consumer-facing metadata (Stage 4 will declare policy; Stage 3 only exposes) ----------

export type CandleQuality = "CLEAN" | "FLAGGED" | "UNKNOWN";

export interface CandleView {
  readonly lifecycle: LifecycleAxis;
  readonly coverage: CoverageAxis;
  readonly quality: CandleQuality;
  readonly feed: FeedAxis;
  readonly temporal: { readonly closed_at: number | null; readonly available_at: number | null; readonly effective_at: number | null };
  readonly provenance: string;
}

/** Three axes kept separate: a CLOSED candle can coexist with DEGRADED feed or unproven range coverage. */
export function describeCandle(bar: Bar | null, feed: FeedAxis, quality: CandleQuality = "UNKNOWN"): CandleView {
  return Object.freeze({
    lifecycle: bar ? bar.status : "NONE",
    coverage: bar ? "OBSERVED" : "MISSING",
    quality,
    feed,
    temporal: Object.freeze({ closed_at: bar?.closed_at ?? null, available_at: bar?.available_at ?? null, effective_at: bar?.effective_at ?? null }),
    provenance: bar ? `internal aggregation (${bar.source})` : "no candle",
  });
}
