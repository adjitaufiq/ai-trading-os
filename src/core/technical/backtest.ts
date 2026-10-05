// QUICK BACKTEST — replays the SAME deterministic evaluate() over bounded broker CLOSED history.
// No second strategy: entries come only from evaluate().entry / reference_plan. No lookahead: at step T only bars
// with available_at <= T and close_time <= T are visible; forming bars never exist here.
// Gross OHLC only: no historical bid/ask ⇒ the step quote is the last CLOSED M5 close (bid = ask). Spread,
// slippage and latency are NOT modelled. Same-bar SL+target touch ⇒ AMBIGUOUS (excluded from win/loss).
import type { Timeframe } from "../contracts";
import type { TechBar } from "./indicators";
import { SLICE_ENV, TIMEFRAMES, evaluate, type TradingSnapshot } from "./tradingState";

export const BACKTEST_VERSION = "quick-backtest-v1-gross-ohlc";
export const BACKTEST_DISCLAIMER = "Backtest gross berdasarkan OHLC broker; spread/slippage/latency historis tidak dimodelkan kecuali data tersedia.";

export type BacktestOutcome = "WIN" | "LOSS" | "AMBIGUOUS" | "OPEN_AT_END";
export interface BacktestTrade {
  readonly side: "BUY" | "SELL";
  readonly regime: string;
  readonly entry_at: number;
  readonly entry: number;
  readonly sl: number;
  readonly target: number;
  readonly exit_at: number | null;
  readonly outcome: BacktestOutcome;
  readonly r: number | null;
  readonly holding_bars: number;
}
export interface BacktestResult {
  readonly version: string;
  readonly evaluated: number;
  readonly buy_candidates: number;
  readonly sell_candidates: number;
  readonly hold: number;
  readonly trades: readonly BacktestTrade[];
  readonly wins: number;
  readonly losses: number;
  readonly ambiguous: number;
  readonly open_at_end: number;
  readonly win_rate: number | null;
  readonly gross_r: number;
  readonly avg_r: number | null;
  readonly max_drawdown_r: number;
  readonly avg_holding_bars: number | null;
  readonly avg_holding_ms: number | null;
  readonly by_regime: Readonly<Record<string, { trades: number; wins: number; losses: number; gross_r: number }>>;
  readonly disclaimer: string;
}

export const visibleAt = (bars: readonly TechBar[], t: number) => {
  let hi = bars.length;
  while (hi > 0 && (bars[hi - 1]!.available_at > t || bars[hi - 1]!.close_time > t)) hi--;
  return bars.slice(0, hi).filter((b) => b.available_at <= t && b.close_time <= t);
};

/** Walks forward M5 bars after entry. Target = TP2 (2R). */
export function resolveTrade(side: "BUY" | "SELL", sl: number, target: number, future: readonly TechBar[]): { outcome: BacktestOutcome; index: number } {
  for (let k = 0; k < future.length; k++) {
    const b = future[k]!;
    const hitSl = side === "BUY" ? b.low <= sl : b.high >= sl;
    const hitTp = side === "BUY" ? b.high >= target : b.low <= target;
    if (hitSl && hitTp) return { outcome: "AMBIGUOUS", index: k };
    if (hitSl) return { outcome: "LOSS", index: k };
    if (hitTp) return { outcome: "WIN", index: k };
  }
  return { outcome: "OPEN_AT_END", index: future.length - 1 };
}

export function runQuickBacktest(history: Readonly<Record<Timeframe, readonly TechBar[]>>, symbol: string, opts: { maxSteps?: number } = {}): BacktestResult {
  const sorted = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, [...history[tf]].sort((a, b) => a.open_time - b.open_time)])) as Record<Timeframe, TechBar[]>;
  const m5 = sorted.M5;
  const steps = m5.slice(-(opts.maxSteps ?? 300));
  let evaluated = 0, buy = 0, sell = 0, hold = 0;
  const trades: BacktestTrade[] = [];
  let prev: TradingSnapshot["signal"] | null = null;
  let busyUntil = -Infinity;
  for (const bar of steps) {
    const t = bar.available_at;
    const closed = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, visibleAt(sorted[tf], t)])) as Record<Timeframe, TechBar[]>;
    const px = closed.M5[closed.M5.length - 1]?.close;
    if (px === undefined) continue;
    const snap = evaluate({ symbol, market_current: true, bars_current: true, quote: { bid: px, ask: px, spread: 0, tick_time_ms: t, observed_at: t }, closed, as_of: t, env: SLICE_ENV }, prev);
    prev = snap.signal;
    if (snap.entry.state === "NOT_EVALUABLE") continue;
    evaluated++;
    if (snap.entry.state === "LONG_CANDIDATE") buy++; else if (snap.entry.state === "SHORT_CANDIDATE") sell++; else hold++;
    const plan = snap.reference_plan;
    if (plan.status !== "AVAILABLE" || t < busyUntil) continue;
    const future = m5.filter((b) => b.open_time >= bar.close_time);
    const { outcome, index } = resolveTrade(plan.side, plan.sl, plan.tp2, future);
    const exitBar = future[index] ?? null;
    trades.push({
      side: plan.side, regime: snap.operator?.regime ?? "UNKNOWN", entry_at: t, entry: plan.entry, sl: plan.sl, target: plan.tp2,
      exit_at: outcome === "OPEN_AT_END" ? null : exitBar?.close_time ?? null, outcome,
      r: outcome === "WIN" ? 2 : outcome === "LOSS" ? -1 : null, holding_bars: outcome === "OPEN_AT_END" ? future.length : index + 1,
    });
    busyUntil = outcome === "OPEN_AT_END" ? Infinity : exitBar?.close_time ?? Infinity; // one position at a time
  }
  const decided = trades.filter((x) => x.r !== null);
  const wins = trades.filter((x) => x.outcome === "WIN").length, losses = trades.filter((x) => x.outcome === "LOSS").length;
  let eq = 0, peak = 0, dd = 0;
  for (const x of [...decided].sort((a, b) => (a.exit_at ?? 0) - (b.exit_at ?? 0))) { eq += x.r!; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const gross = decided.reduce((a, x) => a + x.r!, 0);
  const closedTrades = trades.filter((x) => x.outcome !== "OPEN_AT_END");
  const by: Record<string, { trades: number; wins: number; losses: number; gross_r: number }> = {};
  for (const x of trades) {
    const g = (by[x.regime] ??= { trades: 0, wins: 0, losses: 0, gross_r: 0 });
    g.trades++; if (x.outcome === "WIN") g.wins++; if (x.outcome === "LOSS") g.losses++; g.gross_r += x.r ?? 0;
  }
  return {
    version: BACKTEST_VERSION, evaluated, buy_candidates: buy, sell_candidates: sell, hold, trades,
    wins, losses, ambiguous: trades.filter((x) => x.outcome === "AMBIGUOUS").length, open_at_end: trades.filter((x) => x.outcome === "OPEN_AT_END").length,
    win_rate: wins + losses ? wins / (wins + losses) : null, gross_r: gross, avg_r: decided.length ? gross / decided.length : null, max_drawdown_r: dd,
    avg_holding_bars: closedTrades.length ? closedTrades.reduce((a, x) => a + x.holding_bars, 0) / closedTrades.length : null,
    avg_holding_ms: closedTrades.length ? closedTrades.reduce((a, x) => a + ((x.exit_at ?? x.entry_at) - x.entry_at), 0) / closedTrades.length : null,
    by_regime: by, disclaimer: BACKTEST_DISCLAIMER,
  };
}
