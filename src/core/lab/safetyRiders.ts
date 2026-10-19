import type { LabState } from "./labLedger";

/** Safety Riders (PAPER Lab only): pre-entry filters, never touch open positions or a broker. */
export const SAFETY_PARAMS = Object.freeze({
  POST_SL_COOLDOWN_MS: 15 * 60_000, // 3 closed M5 bars per market after an SL
  SPIKE_ATR_MULT: 1.8, // last closed M5 range > 1.8×ATR14(M5) ⇒ spike
  ATR_PERIOD: 14,
  WICK_SWEEP_RATIO: 0.6, // wick ≥ 60% of range ⇒ whale sweep; block chasing that wick's side
  // Post-exit breath per mode+market (data 547 trades: re-entry <5m ≈ +$0.12/trade, >10m after TRAIL WR 72%).
  BREATH_TP_MS: 5 * 60_000,
  BREATH_TRAIL_MS: 10 * 60_000,
  BREATH_OTHER_MS: 10 * 60_000, // SL / MANUAL / other exits
});

/** Breath length after an exit reason. */
export function breathMs(reason: string | null): number {
  return reason === "TP" ? SAFETY_PARAMS.BREATH_TP_MS : reason === "TRAIL" ? SAFETY_PARAMS.BREATH_TRAIL_MS : SAFETY_PARAMS.BREATH_OTHER_MS;
}

/** Remaining breath (ms) for a mode on a market after its latest exit; 0 when free. */
export function breathLeftMs(s: LabState, strategy: string, symbol: string, now: number): number {
  let left = 0;
  for (const t of s.trades) if (t.symbol === symbol && t.strategy === strategy && t.closed_at) left = Math.max(left, t.closed_at + breathMs(t.exit_reason) - now);
  return Math.max(0, left);
}

export type SafetyBlock = "BLOCK_POST_SL_COOLDOWN" | "BLOCK_SPIKE_VOLATILITY" | "BLOCK_WHALE_WICK_SWEEP" | "BLOCK_POST_EXIT_BREATH";
interface Bar { readonly open: number; readonly high: number; readonly low: number; readonly close: number }

/** Remaining cooldown (ms) for a market after its latest SL exit; 0 when free. */
export function cooldownLeftMs(s: LabState, symbol: string, now: number): number {
  let last = 0;
  for (const t of s.trades) if (t.symbol === symbol && t.exit_reason === "SL" && t.closed_at && t.closed_at > last) last = t.closed_at;
  return last ? Math.max(0, last + SAFETY_PARAMS.POST_SL_COOLDOWN_MS - now) : 0;
}

function atr(bars: readonly Bar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]!, pc = bars[i - 1]!.close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return sum / n;
}

/** Filters signals with the 3 riders. Spike ATR uses the bars BEFORE the last one as baseline. */
export function applySafetyRiders<T extends { side: "BUY" | "SELL"; strategy?: string }>(signals: readonly T[], s: LabState, symbol: string, m5: readonly Bar[], now: number): { pass: T[]; blocked: SafetyBlock | null } {
  if (!signals.length) return { pass: [], blocked: null };
  if (cooldownLeftMs(s, symbol, now) > 0) return { pass: [], blocked: "BLOCK_POST_SL_COOLDOWN" };
  const breathing = signals.filter((x) => !x.strategy || breathLeftMs(s, x.strategy, symbol, now) === 0);
  if (!breathing.length) return { pass: [], blocked: "BLOCK_POST_EXIT_BREATH" };
  const breathBlocked = breathing.length < signals.length;
  signals = breathing;
  const last = m5.at(-1);
  if (!last) return { pass: [...signals], blocked: breathBlocked ? "BLOCK_POST_EXIT_BREATH" : null };
  const range = last.high - last.low;
  const base = atr(m5.slice(0, -1), SAFETY_PARAMS.ATR_PERIOD);
  if (base !== null && base > 0 && range > SAFETY_PARAMS.SPIKE_ATR_MULT * base) return { pass: [], blocked: "BLOCK_SPIKE_VOLATILITY" };
  if (range <= 0) return { pass: [...signals], blocked: breathBlocked ? "BLOCK_POST_EXIT_BREATH" : null };
  const upper = (last.high - Math.max(last.open, last.close)) / range;
  const lower = (Math.min(last.open, last.close) - last.low) / range;
  const pass = signals.filter((x) => !(x.side === "BUY" && upper >= SAFETY_PARAMS.WICK_SWEEP_RATIO) && !(x.side === "SELL" && lower >= SAFETY_PARAMS.WICK_SWEEP_RATIO));
  return { pass, blocked: pass.length < signals.length ? "BLOCK_WHALE_WICK_SWEEP" : breathBlocked ? "BLOCK_POST_EXIT_BREATH" : null };
}
