// SPV (traffic controller) — Strategy Lab PAPER only. Runs after Safety Riders, before entry caps.
// 1) Stale guard: a signal must belong to the newest evaluated M5 candle and be younger than SPV_MAX_AGE_MS.
// 2) Direction lock per symbol per M5 candle: first side wins; opposite side on the same candle is vetoed.
// 3) Priority: same-side signals are ordered by SPV_PRIORITY so structural modes are filled first.
import type { LabState } from "./labLedger";

export const SPV_MAX_AGE_MS = 10 * 60_000; // bar open + 5m close + 5m grace
export const SPV_PRIORITY: readonly string[] = [
  "SMC_FIBO_OTE", "DUAL_WALL_FAST", "GOLD_SNIPER", "FAST_BREAKOUT", "RANGE_REVERSAL",
  "TREND_PULLBACK", "BREAKOUT_RETEST", "EMA_CROSS",
];
export type SpvBlock = "BLOCK_SPV_DIRECTION_LOCK" | "BLOCK_SPV_STALE_SIGNAL";
export interface SpvResult<T> { pass: T[]; blocked: SpvBlock | null; lock: { bar_time: number; side: "BUY" | "SELL" } | null }

const rank = (k?: string) => { const i = k ? SPV_PRIORITY.indexOf(k) : -1; return i < 0 ? SPV_PRIORITY.length : i; };

export function applySpv<T extends { side: "BUY" | "SELL"; strategy?: string; bar_time: number }>(
  signals: readonly T[], s: LabState, symbol: string, now: number,
): SpvResult<T> {
  if (!signals.length) return { pass: [], blocked: null, lock: null };
  const newest = Math.max(...signals.map((x) => x.bar_time));
  const fresh = signals.filter((x) => x.bar_time === newest && now - x.bar_time <= SPV_MAX_AGE_MS);
  if (!fresh.length) return { pass: [], blocked: "BLOCK_SPV_STALE_SIGNAL", lock: null };
  const sorted = [...fresh].sort((a, b) => rank(a.strategy) - rank(b.strategy));
  const existing = s.trades.find((t) => t.symbol === symbol && t.signal_bar_time === newest);
  const side = existing ? existing.side : sorted[0]!.side;
  const pass = sorted.filter((x) => x.side === side);
  const blocked: SpvBlock | null = pass.length < sorted.length ? "BLOCK_SPV_DIRECTION_LOCK" : fresh.length < signals.length ? "BLOCK_SPV_STALE_SIGNAL" : null;
  return { pass, blocked, lock: { bar_time: newest, side } };
}

/** Operator-visible SPV queue (PAPER only): signals of the newest candle that SPV or entry caps held back. */
export type SpvQueueReason = "DIRECTION_LOCK" | "SLOT_FULL";
export interface SpvQueueItem { key: string; symbol: string; strategy: string; side: "BUY" | "SELL"; bar_time: number; reason: SpvQueueReason; queued_at: number }
export const spvKey = (symbol: string, x: { strategy?: string; side: string; bar_time: number }) => `${symbol}:${x.strategy ?? "?"}:${x.side}:${x.bar_time}`;

/** Builds the queue for one symbol; rejected keys never enter it. */
export function buildSpvQueue<T extends { side: "BUY" | "SELL"; strategy?: string; bar_time: number }>(
  symbol: string, fresh: readonly T[], spvPass: readonly T[], opened: readonly T[], now: number,
): SpvQueueItem[] {
  const passSet = new Set(spvPass), openSet = new Set(opened);
  return fresh.filter((x) => !openSet.has(x)).map((x) => ({
    key: spvKey(symbol, x), symbol, strategy: x.strategy ?? "?", side: x.side, bar_time: x.bar_time,
    reason: passSet.has(x) ? "SLOT_FULL" : "DIRECTION_LOCK", queued_at: now,
  }));
}

/** Drops operator-rejected signals (REJECTED_BY_OPERATOR) before SPV. */
export const dropRejected = <T extends { side: string; strategy?: string; bar_time: number }>(symbol: string, xs: readonly T[], rejected: ReadonlySet<string>) =>
  xs.filter((x) => !rejected.has(spvKey(symbol, x)));
