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
import { LivePaperLoop, type PaperDecisionRecord, type PaperPipelineEvent, type PrimaryBiasReading } from "./LivePaperLoop";

export const ALIGNED_REPLAY_VERSION = "aligned-replay-v1" as const;

/** Documented differences vs live paper; reported with every run, never hidden. */
export const ALIGNED_REPLAY_KNOWN_GAPS = Object.freeze([
  "QUOTE: no historical bid/ask ⇒ live=null in LivePaperLoop ⇒ spread 0, bid=ask=M5 close (paper uses latest LIVE bid/ask)",
  "ARENA_QUOTE: evaluate() quote = M5 close with spread 0 (live uses latest LIVE tick)",
  "ASOF: asOf = M5 bar available_at (live uses clock.now() at emission, i.e. slightly later)",
  "HISTORY_MERGE: input is treated as one CLOSED history; live merges BACKFILL history + canonical live bars (no firstLiveAt)",
  "SLIPPAGE/LATENCY: 0 in both paper and replay (not modelled)",
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

export function runAlignedReplay(symbol: string, spec: SymbolSpecification, input: Partial<Record<Timeframe, readonly Bar[]>>, opts: { maxBars?: number } = {}): AlignedReplayResult {
  const missing = validateReplayInput(symbol, input);
  if (missing.length) return Object.freeze({ status: "DATA_MISSING", version: ALIGNED_REPLAY_VERSION, missing: Object.freeze(missing) });
  const bars = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, [...input[tf]!].sort((a, b) => a.open_time - b.open_time)])) as Record<Timeframe, Bar[]>;
  const tech = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, bars[tf].map(toTechBar)])) as Record<Timeframe, TechBar[]>;
  let asOf = 0;
  // Same evaluate() as TechnicalSliceService.evaluateAt, same CLOSED-only visibility filter.
  const provider = (): PrimaryBiasReading => {
    const closed = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, mergeClosedHistory(tech[tf], [], null, asOf)])) as Record<Timeframe, TechBar[]>;
    const px = closed.M5.at(-1)?.close ?? null;
    const snap = evaluate({ symbol, market_current: px !== null, bars_current: true, quote: px === null ? null : { bid: px, ask: px, spread: 0, tick_time_ms: asOf, observed_at: asOf }, closed, as_of: asOf, env: SLICE_ENV }, null);
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
    loop.onClosedM5(bar, visible, null);
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
    if (r.decision?.startsWith("NO_SETUP COUNTER_PRIMARY_BIAS") || r.decision?.startsWith("NO_SETUP NO_PRIMARY_BIAS") || r.decision?.startsWith("SETUP_INVALIDATED")) inc(preGate, r.decision);
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
    summary: Object.freeze({ candidates, gateAllow: allow, gateBlock, preGateBlocks: preGate, downstreamBlocks: down, executed, exits }),
    knownGaps: ALIGNED_REPLAY_KNOWN_GAPS,
  });
}
