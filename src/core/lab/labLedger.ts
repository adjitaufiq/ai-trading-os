// Strategy Lab ledger: virtual $500 PAPER account shared by all modes. No position caps (owner request for experiment).
// Every trade carries its mode (KTP), entry WHY, frozen SL/TP and exit reason. SIMULATION ONLY — no broker path.
import { LAB_PARAMS, LAB_STRATEGIES, STRATEGY_LAB_VERSION, type LabSide, type LabSignal, type LabStrategy } from "./strategies";

export const LAB_START_BALANCE = 500;
/** Fixed experiment lot per symbol and contract size used for USD P&L (estimate, not broker-reported). */
export const LAB_SYMBOLS: Record<string, { lot: number; contract: number }> = {
  XAUUSD: { lot: 0.02, contract: 100 },
  BTCUSD: { lot: 0.05, contract: 1 },
};

export interface LabTrade {
  readonly id: string;
  readonly strategy: LabStrategy;
  readonly symbol: string;
  readonly side: LabSide;
  readonly why: string;
  readonly opened_at: number;
  readonly signal_bar_time: number;
  readonly entry: number;
  readonly sl: number;
  readonly tp: number;
  readonly lot: number;
  readonly status: "OPEN" | "CLOSED";
  readonly mark: number;
  readonly pnl_usd: number;
  readonly closed_at: number | null;
  readonly exit_price: number | null;
  readonly exit_reason: "SL" | "TP" | null;
  readonly version: string;
}

export interface LabState { readonly trades: readonly LabTrade[]; readonly seen: Readonly<Record<string, true>>; readonly started_at: number | null }
export interface LabQuote { readonly bid: number; readonly ask: number }

export const usdPnl = (t: Pick<LabTrade, "side" | "entry" | "lot" | "symbol">, px: number) =>
  (t.side === "BUY" ? px - t.entry : t.entry - px) * t.lot * (LAB_SYMBOLS[t.symbol]?.contract ?? 1);

/** Opens one trade per (strategy, symbol, side, signal bar). No cap on simultaneous positions. Pure. */
export function openSignals(s: LabState, symbol: string, signals: readonly LabSignal[], q: LabQuote, now: number): LabState {
  const cfg = LAB_SYMBOLS[symbol];
  if (!cfg) return s;
  let trades = s.trades, seen = s.seen;
  for (const sig of signals) {
    const key = `${sig.strategy}:${symbol}:${sig.side}:${sig.bar_time}`;
    if (seen[key]) continue;
    seen = { ...seen, [key]: true };
    const entry = sig.side === "BUY" ? q.ask : q.bid;
    const d = sig.sl_distance;
    const t: LabTrade = {
      id: `lab-${now}-${trades.length}`, strategy: sig.strategy, symbol, side: sig.side, why: sig.why, opened_at: now, signal_bar_time: sig.bar_time,
      entry, sl: sig.side === "BUY" ? entry - d : entry + d, tp: sig.side === "BUY" ? entry + d * LAB_PARAMS.TP_R : entry - d * LAB_PARAMS.TP_R,
      lot: cfg.lot, status: "OPEN", mark: entry, pnl_usd: 0, closed_at: null, exit_price: null, exit_reason: null, version: STRATEGY_LAB_VERSION,
    };
    trades = [t, ...trades];
  }
  return { ...s, trades: trades.slice(0, 2000), seen, started_at: s.started_at ?? now };
}

/** Mark open trades of one symbol at the exit side (BUY→bid, SELL→ask); closes at SL first, then TP. Pure. */
export function markSymbol(s: LabState, symbol: string, q: LabQuote, now: number): LabState {
  let changed = false;
  const trades = s.trades.map((t) => {
    if (t.symbol !== symbol || t.status !== "OPEN") return t;
    const px = t.side === "BUY" ? q.bid : q.ask;
    const hitSl = t.side === "BUY" ? px <= t.sl : px >= t.sl;
    const hitTp = t.side === "BUY" ? px >= t.tp : px <= t.tp;
    changed = true;
    if (hitSl || hitTp) {
      const exit = hitSl ? t.sl : t.tp;
      return { ...t, status: "CLOSED" as const, mark: exit, pnl_usd: usdPnl(t, exit), closed_at: now, exit_price: exit, exit_reason: hitSl ? ("SL" as const) : ("TP" as const) };
    }
    return { ...t, mark: px, pnl_usd: usdPnl(t, px) };
  });
  return changed ? { ...s, trades } : s;
}

export interface LabRow { strategy: LabStrategy; trades: number; open: number; wins: number; losses: number; winRate: number | null; realized: number; floating: number }

export function leaderboard(s: LabState): { rows: LabRow[]; balance: number; equity: number } {
  const rows = LAB_STRATEGIES.map((strategy) => {
    const mine = s.trades.filter((t) => t.strategy === strategy);
    const closed = mine.filter((t) => t.status === "CLOSED");
    const wins = closed.filter((t) => t.pnl_usd > 0).length;
    return {
      strategy, trades: closed.length, open: mine.length - closed.length, wins, losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length : null,
      realized: closed.reduce((a, t) => a + t.pnl_usd, 0),
      floating: mine.filter((t) => t.status === "OPEN").reduce((a, t) => a + t.pnl_usd, 0),
    };
  }).sort((a, b) => b.realized - a.realized);
  const realized = rows.reduce((a, r) => a + r.realized, 0), floating = rows.reduce((a, r) => a + r.floating, 0);
  return { rows, balance: LAB_START_BALANCE + realized, equity: LAB_START_BALANCE + realized + floating };
}

export const emptyLab = (): LabState => ({ trades: [], seen: {}, started_at: null });
