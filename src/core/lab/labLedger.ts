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
  readonly exit_reason: "SL" | "TP" | "TRAIL" | "MANUAL" | null;
  readonly version: string;
  /** Exit profile. COPET = 1:1 fixed-dollar TP/SL with $1 step trailing lock. Absent on old trades ⇒ NORMAL. */
  readonly rr_mode?: LabRrMode;
  /** Highest floating P&L seen (USD), COPET only. */
  readonly peak_pnl_usd?: number;
  /** Locked profit floor (USD) once trailing is active, else null. */
  readonly trail_floor_usd?: number | null;
  /** FIBO = technical SL/TP from the signal (Mode 12) with R-based trailing; overrides rr_mode exits. */
  readonly exit_profile?: "FIBO";
  /** Initial risk in USD (FIBO only), used for trailing arm/gap. */
  readonly risk_usd?: number;
  /** Append-only lifecycle observations (lab-lifecycle-v1). Absent on trades opened before instrumentation. */
  readonly lifecycle?: readonly LabLifecycleEvent[];
  readonly lifecycle_truncated?: boolean;
}

export const LAB_LIFECYCLE_VERSION = "lab-lifecycle-v1";
export const LAB_LIFECYCLE_MAX = 60;
export interface LabLifecycleEvent {
  readonly id: string; readonly type: "OPENED" | "TRAIL_FLOOR_SET" | "CLOSED"; readonly at: number;
  readonly price: number | null; readonly pnl_usd: number | null; readonly peak_pnl_usd: number | null;
  readonly trail_floor_usd: number | null; readonly reason: string | null; readonly v: string;
}

/**
 * Observation only: compares two ledger states produced by the unchanged simulation and appends the transitions that
 * actually happened (open, trailing floor change, close). Never alters prices, P&L, status or decisions. Pure.
 */
export function withLifecycle(prev: LabState, next: LabState, now: number): LabState {
  if (prev === next) return next;
  const before = new Map(prev.trades.map((t) => [t.id, t]));
  let changed = false;
  const trades = next.trades.map((t) => {
    const p = before.get(t.id);
    const ev: LabLifecycleEvent[] = [];
    const mk = (type: LabLifecycleEvent["type"], id: string, at: number, price: number | null, reason: string | null): LabLifecycleEvent =>
      ({ id, type, at, price, pnl_usd: t.pnl_usd, peak_pnl_usd: t.peak_pnl_usd ?? null, trail_floor_usd: t.trail_floor_usd ?? null, reason, v: LAB_LIFECYCLE_VERSION });
    if (!p) ev.push(mk("OPENED", `${t.id}:OPENED`, t.opened_at, t.entry, null));
    else {
      if (t.trail_floor_usd != null && t.trail_floor_usd !== (p.trail_floor_usd ?? null)) ev.push(mk("TRAIL_FLOOR_SET", `${t.id}:TRAIL:${t.trail_floor_usd.toFixed(6)}`, now, t.mark, null));
      if (p.status === "OPEN" && t.status === "CLOSED") ev.push(mk("CLOSED", `${t.id}:CLOSED`, t.closed_at ?? now, t.exit_price, t.exit_reason));
    }
    if (!ev.length) return t;
    const log = t.lifecycle ?? p?.lifecycle ?? [];
    const ids = new Set(log.map((e) => e.id));
    let truncated = t.lifecycle_truncated ?? false;
    const add = ev.filter((e) => !ids.has(e.id)).filter((e) => {
      if (e.type === "TRAIL_FLOOR_SET" && log.length >= LAB_LIFECYCLE_MAX) { truncated = true; return false; }
      return true;
    });
    if (!add.length && truncated === (t.lifecycle_truncated ?? false)) return t;
    changed = true;
    return { ...t, lifecycle: [...log, ...add], ...(truncated ? { lifecycle_truncated: true } : {}) };
  });
  return changed ? { ...next, trades } : next;
}

/** One closed-M5 evaluation of one symbol, as recorded by the browser Lab (lab-eval-v1). Reasons are code enums only. */
export interface LabEvalEvent {
  readonly id: string; readonly v: "lab-eval-v1"; readonly symbol: string; readonly bar_time: number; readonly at: number;
  readonly gate: string; readonly candidates: readonly string[]; readonly safety_block: string | null; readonly spv_block: string | null;
  readonly after_spv: readonly string[]; readonly capped: readonly string[]; readonly accepted: readonly string[];
}
export const LAB_EVAL_KEEP = 2000;
/** Append-only by stable id: an id already present is never rewritten. */
export function appendEval(log: readonly LabEvalEvent[], e: LabEvalEvent): LabEvalEvent[] {
  if (log.some((x) => x.id === e.id)) return log as LabEvalEvent[];
  return [...log, e].slice(-LAB_EVAL_KEEP);
}

export type LabRrMode = "NORMAL" | "COPET";
/** Copet v2 (owner rule 2026-10-19), per symbol, 1:1. XAU and BTC SL/TP $10, arm +$3, gap $2 (BTC cut from $20 by owner 2026-10-20, Paper only). */
export const COPET_V2_PARAMS: Readonly<Record<string, Readonly<{ TP_USD: number; SL_USD: number; TRAIL_ARM_USD: number; TRAIL_GAP_USD: number }>>> = Object.freeze({
  XAUUSD: Object.freeze({ TP_USD: 10, SL_USD: 10, TRAIL_ARM_USD: 3, TRAIL_GAP_USD: 1 }),
  BTCUSD: Object.freeze({ TP_USD: 10, SL_USD: 10, TRAIL_ARM_USD: 3, TRAIL_GAP_USD: 1 }),
});
/** Fallback for unknown symbols (legacy v1 values). */
export const COPET_PARAMS = Object.freeze({ TP_USD: 5, SL_USD: 5, TRAIL_ARM_USD: 2, TRAIL_GAP_USD: 1 });
export const copetParams = (symbol: string) => COPET_V2_PARAMS[symbol] ?? COPET_PARAMS;

/** Mode 12 trailing: arms at +1R peak, locks peak − max($1, 0.5R). Wider TP ⇒ wider gap. */
export const FIBO_TRAIL_PARAMS = Object.freeze({ ARM_R: 1, GAP_R: 0.5, MIN_GAP_USD: 1 });

export interface LabState { readonly trades: readonly LabTrade[]; readonly seen: Readonly<Record<string, true>>; readonly started_at: number | null }
export interface LabQuote { readonly bid: number; readonly ask: number }

export const usdPnl = (t: Pick<LabTrade, "side" | "entry" | "lot" | "symbol">, px: number) =>
  (t.side === "BUY" ? px - t.entry : t.entry - px) * t.lot * (LAB_SYMBOLS[t.symbol]?.contract ?? 1);

/** Opens one trade per (strategy, symbol, side, signal bar). No cap on simultaneous positions. Pure. */
export function openSignals(s: LabState, symbol: string, signals: readonly LabSignal[], q: LabQuote, now: number, rrMode: LabRrMode = "NORMAL"): LabState {
  const cfg = LAB_SYMBOLS[symbol];
  if (!cfg) return s;
  let trades = s.trades, seen = s.seen;
  for (const sig of signals) {
    const key = `${sig.strategy}:${symbol}:${sig.side}:${sig.bar_time}`;
    if (seen[key]) continue;
    seen = { ...seen, [key]: true };
    const entry = sig.side === "BUY" ? q.ask : q.bid;
    const fibo = sig.tp_distance !== undefined;
    const abs = fibo && sig.sl_price !== undefined && sig.tp_price !== undefined;
    // Mode 12 absolute levels: fill must still sit strictly between SL and TP, else the signal is void (no chase).
    if (abs && (sig.side === "BUY" ? !(entry > sig.sl_price! && entry < sig.tp_price!) : !(entry < sig.sl_price! && entry > sig.tp_price!))) continue;
    const copet = rrMode === "COPET" && !fibo;
    const usdPerPoint = cfg.lot * cfg.contract;
    const cp = copetParams(symbol);
    const d = abs ? Math.abs(entry - sig.sl_price!) : copet ? cp.SL_USD / usdPerPoint : sig.sl_distance;
    const tpD = fibo ? sig.tp_distance! : copet ? cp.TP_USD / usdPerPoint : d * LAB_PARAMS.TP_R;
    const t: LabTrade = {
      id: `lab-${now}-${trades.length}`, strategy: sig.strategy, symbol, side: sig.side, why: sig.why, opened_at: now, signal_bar_time: sig.bar_time,
      entry,
      sl: abs ? sig.sl_price! : sig.side === "BUY" ? entry - d : entry + d,
      tp: abs ? sig.tp_price! : sig.side === "BUY" ? entry + tpD : entry - tpD,
      lot: cfg.lot, status: "OPEN", mark: entry, pnl_usd: 0, closed_at: null, exit_price: null, exit_reason: null, version: STRATEGY_LAB_VERSION,
      rr_mode: rrMode, peak_pnl_usd: 0, trail_floor_usd: null,
      ...(fibo ? { exit_profile: "FIBO" as const, risk_usd: d * usdPerPoint } : {}),
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
    if (t.exit_profile === "FIBO" && !hitSl && !hitTp) {
      const pnl = usdPnl(t, px), r = t.risk_usd ?? 0;
      const peak = Math.max(t.peak_pnl_usd ?? 0, pnl);
      const floor = r > 0 && peak >= r * FIBO_TRAIL_PARAMS.ARM_R ? peak - Math.max(FIBO_TRAIL_PARAMS.MIN_GAP_USD, r * FIBO_TRAIL_PARAMS.GAP_R) : null;
      if (floor !== null && pnl <= floor) {
        return { ...t, status: "CLOSED" as const, mark: px, pnl_usd: pnl, closed_at: now, exit_price: px, exit_reason: "TRAIL" as const, peak_pnl_usd: peak, trail_floor_usd: floor };
      }
      return { ...t, mark: px, pnl_usd: pnl, peak_pnl_usd: peak, trail_floor_usd: floor };
    }
    if (t.rr_mode === "COPET" && t.exit_profile !== "FIBO" && !hitSl && !hitTp) {
      const pnl = usdPnl(t, px);
      const peak = Math.max(t.peak_pnl_usd ?? 0, pnl);
      const cp = copetParams(t.symbol);
      const floor = peak >= cp.TRAIL_ARM_USD ? peak - cp.TRAIL_GAP_USD : null;
      if (floor !== null && pnl <= floor) {
        return { ...t, status: "CLOSED" as const, mark: px, pnl_usd: pnl, closed_at: now, exit_price: px, exit_reason: "TRAIL" as const, peak_pnl_usd: peak, trail_floor_usd: floor };
      }
      return { ...t, mark: px, pnl_usd: pnl, peak_pnl_usd: peak, trail_floor_usd: floor };
    }
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
