// Operator console for the PAPER Strategy Lab: daily target/max-loss circuit breaker, pause all, manual close.
// Pure helpers; affects only virtual Lab trades. Never reaches broker, Engine Host, Gate or Risk.
import { usdPnl, type LabQuote, type LabState } from "./labLedger";

export const OPERATOR_KEY = "strategy-lab-operator-v1";
export interface OperatorSettings { readonly targetUsd: number; readonly maxLossUsd: number; readonly paused: boolean }
export const DEFAULT_OPERATOR: OperatorSettings = Object.freeze({ targetUsd: 50, maxLossUsd: 30, paused: false });

export function parseOperator(raw: unknown): OperatorSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<OperatorSettings>;
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return { targetUsd: pos(o.targetUsd, DEFAULT_OPERATOR.targetUsd), maxLossUsd: pos(o.maxLossUsd, DEFAULT_OPERATOR.maxLossUsd), paused: o.paused === true };
}

const WIB_MS = 7 * 3_600_000;
/** Start of the current WIB (UTC+7) calendar day in epoch ms. */
export const wibDayStart = (now: number) => Math.floor((now + WIB_MS) / 86_400_000) * 86_400_000 - WIB_MS;

/** Realized P/L of trades closed since today's WIB midnight. */
export function todayRealized(s: LabState, now: number): number {
  const start = wibDayStart(now);
  return s.trades.reduce((a, t) => (t.status === "CLOSED" && (t.closed_at ?? 0) >= start ? a + t.pnl_usd : a), 0);
}

export type GateState = "RUNNING" | "PAUSED" | "TARGET_HIT" | "MAX_LOSS_HIT";
export function gateState(s: LabState, op: OperatorSettings, now: number): GateState {
  if (op.paused) return "PAUSED";
  const r = todayRealized(s, now);
  if (r >= op.targetUsd) return "TARGET_HIT";
  if (r <= -op.maxLossUsd) return "MAX_LOSS_HIT";
  return "RUNNING";
}

/** Manually closes the given OPEN trades at the exit side of the last quote (BUY→bid, SELL→ask). Missing quote ⇒ trade stays open. */
export function closeManual(s: LabState, ids: readonly string[] | "ALL", quotes: Readonly<Record<string, LabQuote>>, now: number): LabState {
  let changed = false;
  const trades = s.trades.map((t) => {
    if (t.status !== "OPEN" || (ids !== "ALL" && !ids.includes(t.id))) return t;
    const q = quotes[t.symbol];
    if (!q) return t;
    const px = t.side === "BUY" ? q.bid : q.ask;
    changed = true;
    return { ...t, status: "CLOSED" as const, mark: px, pnl_usd: usdPnl(t, px), closed_at: now, exit_price: px, exit_reason: "MANUAL" as const };
  });
  return changed ? { ...s, trades } : s;
}
