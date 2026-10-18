// Operator console for the PAPER Strategy Lab: daily target/max-loss circuit breaker, pause all, manual close, entry limits.
// Pure helpers; affects only virtual Lab trades. Never reaches broker, Engine Host, Gate or Risk.
import { usdPnl, type LabQuote, type LabState } from "./labLedger";
import { LAB_STRATEGIES, type LabStrategy } from "./strategies";

export const OPERATOR_KEY = "strategy-lab-operator-v1";
export interface OperatorSettings {
  readonly targetUsd: number; readonly maxLossUsd: number; readonly paused: boolean;
  /** Max simultaneous OPEN Lab entries across all modes and markets. */
  readonly maxOpenTotal: number;
  /** Legacy per-mode limit (kept for stored settings); entries are now capped per mode per market. */
  readonly maxOpenPerMode: Readonly<Record<LabStrategy, number>>;
  /** Max simultaneous OPEN entries per mode per market; 0 = mode inactive on that market. */
  readonly marketQuota: Readonly<Record<LabStrategy, Readonly<Record<LabMarket, number>>>>;
}
export const LAB_MARKETS = ["XAUUSD", "BTCUSD"] as const;
export type LabMarket = (typeof LAB_MARKETS)[number];
export const DEFAULT_MAX_TOTAL = 10;
export const DEFAULT_MAX_PER_MODE = 1;
export const DEFAULT_MARKET_QUOTA = 1;
const perModeDefault = () => Object.fromEntries(LAB_STRATEGIES.map((s) => [s, DEFAULT_MAX_PER_MODE])) as Record<LabStrategy, number>;
const quotaDefault = () => Object.fromEntries(LAB_STRATEGIES.map((s) => [s, { XAUUSD: DEFAULT_MARKET_QUOTA, BTCUSD: DEFAULT_MARKET_QUOTA }])) as Record<LabStrategy, Record<LabMarket, number>>;
export const DEFAULT_OPERATOR: OperatorSettings = Object.freeze({ targetUsd: 50, maxLossUsd: 30, paused: false, maxOpenTotal: DEFAULT_MAX_TOTAL, maxOpenPerMode: perModeDefault(), marketQuota: quotaDefault() });

const posInt = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : d);
const nonNegInt = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d);
export function parseOperator(raw: unknown): OperatorSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<OperatorSettings>;
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const pm = perModeDefault();
  const src = (o.maxOpenPerMode && typeof o.maxOpenPerMode === "object" ? o.maxOpenPerMode : {}) as Record<string, unknown>;
  for (const s of LAB_STRATEGIES) pm[s] = posInt(src[s], DEFAULT_MAX_PER_MODE);
  const legacy = !(o.marketQuota && typeof o.marketQuota === "object");
  const mq = quotaDefault();
  const qsrc = (legacy ? {} : o.marketQuota) as Record<string, Record<string, unknown> | undefined>;
  for (const s of LAB_STRATEGIES) for (const m of LAB_MARKETS) mq[s][m] = nonNegInt(qsrc[s]?.[m], DEFAULT_MARKET_QUOTA);
  // Settings saved before per-market quotas move to the new 10-slot global default once.
  const total = legacy ? DEFAULT_MAX_TOTAL : posInt(o.maxOpenTotal, DEFAULT_MAX_TOTAL);
  return { targetUsd: pos(o.targetUsd, DEFAULT_OPERATOR.targetUsd), maxLossUsd: pos(o.maxLossUsd, DEFAULT_OPERATOR.maxLossUsd), paused: o.paused === true, maxOpenTotal: total, maxOpenPerMode: pm, marketQuota: mq };
}

export const quotaOf = (op: OperatorSettings, strategy: LabStrategy, symbol: string): number =>
  op.marketQuota[strategy]?.[symbol as LabMarket] ?? 0;

/** Keeps only signals for `symbol` that fit the per-mode-per-market quota and the global open-entry limit, in signal order. */
export function capEntries<T extends { strategy: LabStrategy }>(signals: readonly T[], s: LabState, op: OperatorSettings, symbol: string): T[] {
  const open = s.trades.filter((t) => t.status === "OPEN");
  let total = open.length;
  const per: Partial<Record<LabStrategy, number>> = {};
  for (const t of open) if (t.symbol === symbol) per[t.strategy] = (per[t.strategy] ?? 0) + 1;
  const out: T[] = [];
  for (const sig of signals) {
    if (total >= op.maxOpenTotal) break;
    const n = per[sig.strategy] ?? 0;
    if (n >= quotaOf(op, sig.strategy, symbol)) continue;
    out.push(sig); per[sig.strategy] = n + 1; total++;
  }
  return out;
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
