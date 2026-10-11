// Aligned backtest: replays broker CLOSED bars (native M5/M15/H1/H4, never aggregated) through the SAME LivePaperLoop
// used by paper/demo — same M1B.3–7, M2 lifecycle, primaryBias gate, Decision Gate, M3, M4, fill and exit code.
// The primaryBias provider calls the SAME ARENA evaluate() that TechnicalSliceService.evaluateAt calls, over bars
// visible at asOf (available_at/close_time <= asOf). No new gate, no strategy change. PAPER ONLY, no broker import.
import type { Bar, Timeframe } from "../contracts";
import type { SymbolSpecification } from "../broker/types";
import { mergeClosedHistory, toTechBar } from "../technical/TechnicalSliceService";
import { SLICE_ENV, TIMEFRAMES, evaluate } from "../technical/tradingState";
import type { TechBar } from "../technical/indicators";
import type { JournalTrade } from "../../engine/journal/types";
import type { BrokerMarketEvent } from "../broker/types";
import { LivePaperLoop, type PaperDecisionRecord, type PaperPipelineEvent, type PrimaryBiasReading } from "./LivePaperLoop";

export const ALIGNED_REPLAY_VERSION = "aligned-replay-v2-cost-model" as const;

/** Decision timing (same as paper/demo): CANDLE_CLOSE — LivePaperLoop runs once per CLOSED M5 emission
 *  (MarketRuntime.ts M5.onBar CLOSED). Ticks only supply the fill quote (lastLive); no tick-based decisions exist. */
export const DECISION_TIMING = "CANDLE_CLOSE_M5" as const;

/**
 * Execution-cost model. No historical bid/ask exists in broker /v1/bars ⇒ spread is an EXPLICIT assumption,
 * fed through the SAME `live` quote argument paper uses (bid = M5 close, ask = close + spread). Slippage and latency
 * are 0 because LivePaperLoop hardcodes them to 0 for paper too (changing that would change execution). Spread 0 is
 * rejected unless explicitly declared via allowZeroSpread.
 */
export interface ReplayCostModel {
  readonly spread: number;
  readonly source: "ASSUMED_FIXED" | "OBSERVED_LIVE_SAMPLE";
  readonly note: string;
  readonly slippage: 0;
  readonly latencyMs: 0;
  readonly allowZeroSpread?: boolean;
}

/** Documented differences vs live paper; reported with every run, never hidden. */
export const ALIGNED_REPLAY_KNOWN_GAPS = Object.freeze([
  "QUOTE: no historical bid/ask ⇒ fill quote = M5 close + ASSUMED fixed spread (costModel), not the real tick at emission",
  "ARENA_QUOTE: evaluate() quote = M5 close bid, close+assumed spread ask (live uses latest LIVE tick)",
  "ASOF: asOf = M5 bar available_at (live uses clock.now() at emission, i.e. slightly later)",
  "HISTORY_MERGE: input is treated as one CLOSED history; live merges BACKFILL history + canonical live bars (no firstLiveAt)",
  "SLIPPAGE/LATENCY: 0 in both paper and replay (LivePaperLoop hardcodes 0; not modelled anywhere)",
  "SPREAD_VARIATION: fixed spread; session/news widening not modelled",
]);

export interface AlignedReplayRow {
  readonly at: number; readonly symbol: string;
  readonly primaryBias: string | null; readonly arenaStatus: string | null;
  /** Loop decision string after this bar (e.g. NO_SETUP MID_RANGE, GATE_BLOCK BLOCK_ARENA_HOLD). */
  readonly decision: string | null;
  readonly m2State: string | null; readonly m2Direction: string | null;
  readonly records: readonly PaperDecisionRecord[];
  readonly events: readonly PaperPipelineEvent[];
}

export type AlignedReplayResult =
  | { readonly status: "DATA_MISSING"; readonly version: typeof ALIGNED_REPLAY_VERSION; readonly missing: readonly string[] }
  | {
      readonly status: "DONE"; readonly version: typeof ALIGNED_REPLAY_VERSION; readonly symbol: string; readonly barsReplayed: number;
      readonly rows: readonly AlignedReplayRow[]; readonly trades: readonly Readonly<JournalTrade>[];
      readonly summary: {
        readonly candidates: number; readonly gateAllow: number; readonly gateBlock: Readonly<Record<string, number>>;
        readonly preGateBlocks: Readonly<Record<string, number>>; readonly downstreamBlocks: Readonly<Record<string, number>>;
        readonly executed: number; readonly exits: number;
      };
      readonly decisionTiming: typeof DECISION_TIMING;
      readonly costModel: ReplayCostModel;
      /** Per-trade journal annotation of the cost assumption used (trades themselves are unmodified loop output). */
      readonly tradeCostJournal: readonly { readonly tradeId: string; readonly costModel: ReplayCostModel }[];
      readonly knownGaps: readonly string[];
    };

/** Strict input validation: every timeframe must be native broker CLOSED bars for this symbol. No fallback. */
export function validateReplayInput(symbol: string, bars: Partial<Record<Timeframe, readonly Bar[]>>): string[] {
  const missing: string[] = [];
  for (const tf of TIMEFRAMES) {
    const b = bars[tf];
    if (!b || b.length === 0) { missing.push(`${tf}: no bars`); continue; }
    if (b.some((x) => x.timeframe !== tf)) missing.push(`${tf}: wrong timeframe in series`);
    if (b.some((x) => x.symbol !== symbol)) missing.push(`${tf}: symbol mismatch`);
    if (b.some((x) => x.status !== "CLOSED")) missing.push(`${tf}: non-CLOSED bar`);
  }
  return missing;
}

export function runAlignedReplay(symbol: string, spec: SymbolSpecification, input: Partial<Record<Timeframe, readonly Bar[]>>, opts: { maxBars?: number; costModel: ReplayCostModel }): AlignedReplayResult {
  const missing = validateReplayInput(symbol, input);
  const cost = opts.costModel;
  if (!cost || !Number.isFinite(cost.spread) || cost.spread < 0) missing.push("costModel: spread missing/invalid");
  else if (cost.spread === 0 && !cost.allowZeroSpread) missing.push("costModel: spread 0 requires explicit allowZeroSpread");
  if (missing.length) return Object.freeze({ status: "DATA_MISSING", version: ALIGNED_REPLAY_VERSION, missing: Object.freeze(missing) });
  const bars = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, [...input[tf]!].sort((a, b) => a.open_time - b.open_time)])) as Record<Timeframe, Bar[]>;
  const tech = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, bars[tf].map(toTechBar)])) as Record<Timeframe, TechBar[]>;
  let asOf = 0;
  // Same evaluate() as TechnicalSliceService.evaluateAt, same CLOSED-only visibility filter.
  const provider = (): PrimaryBiasReading => {
    const closed = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, mergeClosedHistory(tech[tf], [], null, asOf)])) as Record<Timeframe, TechBar[]>;
    const px = closed.M5.at(-1)?.close ?? null;
    const snap = evaluate({ symbol, market_current: px !== null, bars_current: true, quote: px === null ? null : { bid: px, ask: px + cost.spread, spread: cost.spread, tick_time_ms: asOf, observed_at: asOf }, closed, as_of: asOf, env: SLICE_ENV }, null);
    return { bias: snap.primary_bias, asOf, source: "TECHNICAL_H4_CLOSED", arenaStatus: snap.operator?.status ?? null };
  };
  const loop = new LivePaperLoop(symbol, "BACKTEST", spec, provider);
  let pending: PaperPipelineEvent[] = [];
  loop.onPipelineEvent((e) => pending.push(e));
  const visible = (tf: Timeframe) => bars[tf].filter((b) => b.available_at <= asOf && b.close_time <= asOf);
  const rows: AlignedReplayRow[] = [];
  const m5 = opts.maxBars ? bars.M5.slice(-opts.maxBars) : bars.M5;
  for (const bar of m5) {
    asOf = bar.available_at;
    pending = [];
    // Same argument paper receives (lastLive), built from the explicit cost assumption.
    const live = Object.freeze({ seq: rows.length + 1, symbol, source: "MT5", bid: bar.close, ask: bar.close + cost.spread, spread: cost.spread,
      event_at: bar.close_time, observed_at: bar.available_at, ingested_at: bar.available_at,
      provenance: { raw_event_id: `replay-cost-${bar.close_time}`, source: "MT5", symbol, received_at: bar.available_at, normalizer_version: "replay-cost-model", connection_epoch: 0, delivery: "BACKFILL" } }) as unknown as BrokerMarketEvent;
    loop.mark(live);
    loop.onClosedM5(bar, visible, live);
    const rd = loop.readiness();
    rows.push(Object.freeze({
      at: bar.close_time, symbol, primaryBias: rd.primaryBias?.bias ?? null, arenaStatus: rd.primaryBias?.arenaStatus ?? null,
      decision: rd.decision, m2State: rd.m2?.at === bar.close_time ? rd.m2.state : null, m2Direction: rd.m2?.at === bar.close_time ? rd.m2.direction : null,
      records: Object.freeze(loop.decisions().filter((r) => r.at === bar.close_time)), events: Object.freeze(pending),
    }));
  }
  const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const gateBlock: Record<string, number> = {}, preGate: Record<string, number> = {}, down: Record<string, number> = {};
  let candidates = 0, allow = 0, executed = 0, exits = 0;
  for (const r of rows) {
    if (r.decision?.startsWith("NO_SETUP BLOCK_COUNTER_PRIMARY_BIAS") || r.decision?.startsWith("NO_SETUP NO_PRIMARY_BIAS") || r.decision?.startsWith("SETUP_INVALIDATED")) inc(preGate, r.decision);
    for (const x of r.records) {
      if (x.kind === "CANDIDATE") candidates++;
      if (x.kind === "GATE") { if (x.outcome === "ALLOW") allow++; else inc(gateBlock, x.reason); }
    }
    for (const e of r.events) {
      if (e.type === "EXECUTION") executed++;
      if (e.type === "EXIT") exits++;
      if (e.type === "BLOCKED" && e.stage !== "DECISION") inc(down, `${e.stage} ${e.reason}`);
    }
  }
  return Object.freeze({
    status: "DONE", version: ALIGNED_REPLAY_VERSION, symbol, barsReplayed: m5.length, rows: Object.freeze(rows), trades: loop.trades(),
    decisionTiming: DECISION_TIMING, costModel: Object.freeze({ ...cost }),
    tradeCostJournal: Object.freeze(loop.trades().map((t) => Object.freeze({ tradeId: String((t as { id?: string; tradeId?: string }).id ?? (t as { tradeId?: string }).tradeId ?? ""), costModel: cost }))),
    summary: Object.freeze({ candidates, gateAllow: allow, gateBlock, preGateBlocks: preGate, downstreamBlocks: down, executed, exits }),
    knownGaps: ALIGNED_REPLAY_KNOWN_GAPS,
  });
}
