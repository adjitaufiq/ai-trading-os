// PAPER / SIMULATION trading + journal. Frontend-only, local persistence.
// SIMULATION ONLY: nothing here talks to a broker, gateway, account or order API. There is no order path.
import { buildSidePlan, planInvariantHolds, RADAR_PLAN_POLICY_VERSION, SIGNAL_TTL_POLICY_VERSION, type TradingSnapshot } from "@/core/technical/tradingState";
import { compactSummary, engineSignalOf, type CompactSummary, type EngineSignal } from "./tradeSummary";

export type PaperSide = "BUY" | "SELL";
export type ExitReason = "MANUAL" | "SL" | "TP1" | "TP2" | "SIGNAL_CHANGE";
/** Auto-close target for paper positions (and quick backtest). Explicit, not a tuned parameter. */
export const PAPER_TARGET = "TP2" as const;

export interface PaperPosition {
  readonly id: string;
  readonly symbol: string;
  readonly side: PaperSide;
  readonly mode: "SIMULATION";
  readonly opened_at: number;
  readonly entry: number;
  readonly mark: number;
  readonly sl: number | null;
  readonly tp1: number | null;
  readonly tp2: number | null;
  readonly engine_signal: EngineSignal;
  readonly manual_against_engine: boolean;
  readonly context: CompactSummary | null;
  readonly status: "OPEN" | "CLOSED";
  readonly closed_at: number | null;
  readonly exit_price: number | null;
  readonly pnl: number | null;
  readonly r_multiple: number | null;
  readonly exit_reason: ExitReason | null;
  // ---- plan-at-open provenance (optional: older stored positions lack them) ----
  readonly action_source?: ActionSource;
  readonly engine_search?: "CARI_BUY" | "CARI_SELL" | "HOLD" | null;
  readonly engine_actionable_signal?: EngineSignal;
  readonly plan_source?: PlanSource | null;
  readonly plan_unavailable_reason?: string | null;
  readonly policy_versions?: Readonly<Record<string, string>> | null;
  readonly engine_signal_id?: string | null;
  readonly engine_signal_origin_entry?: number | null;
}
export type ActionSource = "ENGINE_ALIGNED" | "MANUAL_EARLY" | "MANUAL_AGAINST_ENGINE";
export type PlanSource = "SIGNAL_PLAN" | "RADAR_REBASED_TO_ACTUAL_ENTRY" | "CURRENT_EVIDENCE_REBASED_TO_ACTUAL_ENTRY";

export type JournalEntry =
  | { readonly id: string; readonly type: "SIGNAL"; readonly at: number; readonly symbol: string; readonly from: EngineSignal; readonly to: EngineSignal; readonly context: CompactSummary | null }
  | { readonly id: string; readonly type: "LIFECYCLE"; readonly at: number; readonly symbol: string; readonly lifecycle: LifecycleCompact }
  | { readonly id: string; readonly type: "TRADE_OPEN" | "TRADE_CLOSE"; readonly at: number; readonly symbol: string; readonly position: PaperPosition };

export interface LifecycleCompact {
  readonly event: "READY_CREATED" | "FRESH_READY_CREATED" | "READY_EXPIRED" | "READY_INVALIDATED" | "READY_MISSED_CHASING";
  readonly signal_id: string; readonly side: "BUY" | "SELL"; readonly reason: string | null;
  readonly origin_entry: number; readonly origin_sl: number | null; readonly initial_r: number | null;
  readonly trigger: string; readonly trigger_time: number; readonly trigger_high: number; readonly trigger_low: number;
  readonly ttl_bars: number; readonly ttl_remaining: number | null;
  readonly alignment: string; readonly scalp_momentum: string; readonly ttl_policy_version: string;
}

/** Compact lifecycle event from a snapshot, or null when nothing important happened. Pure. */
export function lifecycleOf(s: TradingSnapshot | null): LifecycleCompact | null {
  const lc = s?.signal.lifecycle;
  if (!s || !lc) return null;
  const ev = lc.event;
  if (ev !== "READY_CREATED" && ev !== "FRESH_READY_CREATED" && ev !== "READY_EXPIRED" && ev !== "READY_INVALIDATED" && ev !== "READY_MISSED_CHASING") return null;
  const o = ev.endsWith("CREATED") ? s.signal.origin : lc.last_terminal?.origin;
  if (!o) return null;
  return { event: ev, signal_id: o.signal_id, side: o.side, reason: lc.reason, origin_entry: o.origin_entry, origin_sl: o.origin_sl, initial_r: o.initial_r,
    trigger: `${o.trigger_tf}:${o.trigger_patterns.join("+")}`, trigger_time: o.trigger_bar_open_time, trigger_high: o.trigger_high, trigger_low: o.trigger_low,
    ttl_bars: o.ttl_bars, ttl_remaining: ev.endsWith("CREATED") ? s.signal.ttl_remaining_bars ?? o.ttl_bars : 0,
    alignment: o.origin_macro_alignment, scalp_momentum: o.origin_scalp_momentum, ttl_policy_version: o.ttl_policy_version };
}

export interface Quote { readonly bid: number; readonly ask: number }

/** BUY fills at ASK, SELL at BID (paper). SL/TP are frozen at open from the same side plan builder; never mutated afterwards. */
export function openPaper(args: { symbol: string; side: PaperSide; quote: Quote; now: number; snapshot: TradingSnapshot | null; id: string }): PaperPosition {
  const { symbol, side, quote, now, snapshot, id } = args;
  const entry = side === "BUY" ? quote.ask : quote.bid;
  const engine = engineSignalOf(snapshot);
  const search = snapshot?.operator?.status ?? null;
  const searchSide = search === "CARI_BUY" ? "BUY" : search === "CARI_SELL" ? "SELL" : null;
  const action_source: ActionSource = engine === side ? "ENGINE_ALIGNED" : engine === "HOLD" && searchSide === side ? "MANUAL_EARLY" : "MANUAL_AGAINST_ENGINE";
  let levels: { sl: number; tp1: number; tp2: number } | null = null, plan_source: PlanSource | null = null, reason: string | null = null;
  const ref = snapshot?.reference_plan;
  if (action_source === "ENGINE_ALIGNED" && ref?.status === "AVAILABLE" && ref.side === side && planInvariantHolds(side, ref.sl, entry, ref.tp1, ref.tp2)) { levels = ref; plan_source = "SIGNAL_PLAN"; }
  else {
    const p = buildSidePlan(side, entry, snapshot?.evidence ?? null, snapshot?.operator ?? null);
    if (p.ok) { levels = p; plan_source = action_source === "MANUAL_EARLY" ? "RADAR_REBASED_TO_ACTUAL_ENTRY" : "CURRENT_EVIDENCE_REBASED_TO_ACTUAL_ENTRY"; }
    else reason = p.reason;
  }
  return Object.freeze({
    id, symbol, side, mode: "SIMULATION", opened_at: now, entry, mark: side === "BUY" ? quote.bid : quote.ask,
    sl: levels?.sl ?? null, tp1: levels?.tp1 ?? null, tp2: levels?.tp2 ?? null,
    engine_signal: engine, manual_against_engine: engine !== side,
    context: snapshot && snapshot.availability !== "UNAVAILABLE" ? compactSummary(snapshot) : null,
    status: "OPEN", closed_at: null, exit_price: null, pnl: null, r_multiple: null, exit_reason: null,
    action_source, engine_search: search, engine_actionable_signal: engine, plan_source, plan_unavailable_reason: reason,
    policy_versions: snapshot ? { ...snapshot.versions, radar_plan_policy_version: RADAR_PLAN_POLICY_VERSION, signal_ttl_policy_version: SIGNAL_TTL_POLICY_VERSION } : null,
    engine_signal_id: action_source === "ENGINE_ALIGNED" ? snapshot?.signal.origin?.signal_id ?? null : null,
    engine_signal_origin_entry: action_source === "ENGINE_ALIGNED" ? snapshot?.signal.origin?.origin_entry ?? null : null,
  });
}

const pnlOf = (p: PaperPosition, px: number) => (p.side === "BUY" ? px - p.entry : p.entry - px);
const rOf = (p: PaperPosition, px: number) => {
  if (p.sl === null) return null;
  const risk = p.side === "BUY" ? p.entry - p.sl : p.sl - p.entry;
  return risk > 0 ? pnlOf(p, px) / risk : null;
};

export function closePaper(p: PaperPosition, price: number, now: number, reason: ExitReason): PaperPosition {
  return Object.freeze({ ...p, mark: price, status: "CLOSED", closed_at: now, exit_price: price, pnl: pnlOf(p, price), r_multiple: rOf(p, price), exit_reason: reason });
}

/** Mark-to-market from a live quote (exit side: BUY→BID, SELL→ASK). Auto-closes on SL / target touch. */
export function markPaper(p: PaperPosition, quote: Quote, now: number): PaperPosition {
  if (p.status !== "OPEN") return p;
  const px = p.side === "BUY" ? quote.bid : quote.ask;
  const target = p.tp2;
  if (p.sl !== null && (p.side === "BUY" ? px <= p.sl : px >= p.sl)) return closePaper(p, px, now, "SL");
  if (target !== null && (p.side === "BUY" ? px >= target : px <= target)) return closePaper(p, px, now, PAPER_TARGET);
  return px === p.mark ? p : Object.freeze({ ...p, mark: px, pnl: pnlOf(p, px), r_multiple: rOf(p, px) });
}

// ---------------- store ----------------
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const KEY = "paper-journal-v1";
export const JOURNAL_MAX = 500;
export const ENTRY_MAX_CHARS = 20_000;

interface State { positions: PaperPosition[]; journal: JournalEntry[]; lastSignal: Record<string, EngineSignal>; lastLifecycle?: Record<string, string> }

export class PaperJournalStore {
  private state: State;
  private listeners = new Set<() => void>();
  private seq = 0;
  constructor(private readonly kv: KV | null) {
    let s: State = { positions: [], journal: [], lastSignal: {} };
    try { const raw = kv?.getItem(KEY); if (raw) s = { ...s, ...JSON.parse(raw) }; } catch { /* corrupt store ⇒ start empty */ }
    this.state = s;
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getState = () => this.state;
  private nextId(prefix: string, now: number) { return `${prefix}-${now}-${++this.seq}`; }
  private commit(next: State) {
    this.state = next;
    try { this.kv?.setItem(KEY, JSON.stringify(next)); } catch { /* quota: keep in memory */ }
    for (const l of this.listeners) l();
  }
  private push(entries: JournalEntry[], e: JournalEntry) {
    const fits = JSON.stringify(e).length <= ENTRY_MAX_CHARS;
    const safe: JournalEntry = fits || e.type === "LIFECYCLE" ? e : e.type === "SIGNAL" ? { ...e, context: null } : { ...e, position: { ...e.position, context: null } };
    return [safe, ...entries].slice(0, JOURNAL_MAX);
  }

  /** Records only real ENGINE signal changes per symbol (not every tick). Returns true when recorded. */
  recordSignal(snapshot: TradingSnapshot | null, symbol: string, now: number): boolean {
    if (!snapshot || snapshot.availability === "UNAVAILABLE") return false;
    const to = engineSignalOf(snapshot);
    const from = this.state.lastSignal[symbol];
    if (from === to) return false;
    const lastSignal = { ...this.state.lastSignal, [symbol]: to };
    if (from === undefined) { this.commit({ ...this.state, lastSignal }); return false; } // baseline, not a transition
    this.commit({ ...this.state, lastSignal, journal: this.push(this.state.journal, { id: this.nextId("sig", now), type: "SIGNAL", at: now, symbol, from, to, context: compactSummary(snapshot) }) });
    return true;
  }

  /** Records important READY lifecycle events once (dedup key = event + signal_id). */
  recordLifecycle(snapshot: TradingSnapshot | null, symbol: string, now: number): boolean {
    const l = lifecycleOf(snapshot);
    if (!l) return false;
    const key = `${l.event}:${l.signal_id}`;
    if (this.state.lastLifecycle?.[symbol] === key) return false;
    this.commit({ ...this.state, lastLifecycle: { ...this.state.lastLifecycle, [symbol]: key }, journal: this.push(this.state.journal, { id: this.nextId("life", now), type: "LIFECYCLE", at: now, symbol, lifecycle: l }) });
    return true;
  }

  open(args: { symbol: string; side: PaperSide; quote: Quote; now: number; snapshot: TradingSnapshot | null }): PaperPosition {
    const p = openPaper({ ...args, id: this.nextId("paper", args.now) });
    this.commit({ ...this.state, positions: [p, ...this.state.positions].slice(0, JOURNAL_MAX), journal: this.push(this.state.journal, { id: this.nextId("open", args.now), type: "TRADE_OPEN", at: args.now, symbol: p.symbol, position: p }) });
    return p;
  }

  private replace(updated: PaperPosition[], closed: PaperPosition[], now: number) {
    let journal = this.state.journal;
    for (const c of closed) journal = this.push(journal, { id: this.nextId("close", now), type: "TRADE_CLOSE", at: now, symbol: c.symbol, position: c });
    this.commit({ ...this.state, positions: updated, journal });
  }

  close(id: string, quote: Quote, now: number, reason: ExitReason = "MANUAL") {
    const p = this.state.positions.find((x) => x.id === id && x.status === "OPEN");
    if (!p) return;
    const c = closePaper(p, p.side === "BUY" ? quote.bid : quote.ask, now, reason);
    this.replace(this.state.positions.map((x) => (x.id === id ? c : x)), [c], now);
  }

  mark(symbol: string, quote: Quote, now: number) {
    let changed = false; const closed: PaperPosition[] = [];
    const next = this.state.positions.map((p) => {
      if (p.symbol !== symbol || p.status !== "OPEN") return p;
      const m = markPaper(p, quote, now);
      if (m !== p) { changed = true; if (m.status === "CLOSED") closed.push(m); }
      return m;
    });
    if (!changed) return;
    if (closed.length) this.replace(next, closed, now);
    else { this.state = { ...this.state, positions: next }; for (const l of this.listeners) l(); }
  }

  clear() { this.commit({ positions: [], journal: [], lastSignal: this.state.lastSignal, lastLifecycle: this.state.lastLifecycle ?? {} }); }
}

let shared: PaperJournalStore | null = null;
export function sharedPaperJournal(): PaperJournalStore {
  if (!shared) shared = new PaperJournalStore(typeof window !== "undefined" ? window.localStorage : null);
  return shared;
}
