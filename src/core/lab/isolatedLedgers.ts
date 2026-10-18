// Isolated Strategy Lab ledgers: one virtual $50 PAPER account per (strategy × exit profile). The same signals and
// quotes feed NORMAL and COPET so the exit profiles are compared on identical entries. Balances, positions, P/L
// and history never mix between ledgers. Reuses the shared openSignals/markSymbol rules unchanged. SIMULATION ONLY:
// no broker path, no margin / insufficient-funds rule, no commission/swap/slippage modelled.
import { LAB_STRATEGIES, type LabSignal, type LabStrategy } from "./strategies";
import { emptyLab, LAB_SYMBOLS, markSymbol, openSignals, type LabQuote, type LabRrMode, type LabState, type LabTrade } from "./labLedger";

export const LEDGER_START_BALANCE = 50;
export const LEDGER_PROFILES: readonly LabRrMode[] = ["NORMAL", "COPET"];
export const LEDGER_COSTS_NOTE = "Biaya broker (komisi, swap, slippage) belum dimodelkan; fill = Bid/Ask live. Tanpa aturan margin: saldo bisa negatif.";

export type LedgerKey = `${LabStrategy}:${LabRrMode}`;
export interface Ledger { readonly key: LedgerKey; readonly strategy: LabStrategy; readonly profile: LabRrMode; readonly start_balance: number; readonly started_at: number; readonly state: LabState; readonly topups?: readonly LedgerTopup[] }
export interface LedgerTopup { readonly id: string; readonly amount: number; readonly at: number; readonly note: string }
/** One-off labelled capital injection: Mode 1 round 2 after the H1 EMA 9/21 compass. Never resets history. */
export const TOUCH_TOPUP: Omit<LedgerTopup, "at"> = { id: "touch-h1-compass-r2", amount: 50, note: "Ronde 2 · Sentuh S/R + EMA 9/21" };
export interface LedgerBook { readonly version: "lab-ledgers-v1"; readonly started_at: number; readonly ledgers: Readonly<Record<string, Ledger>> }

export const ledgerKey = (strategy: LabStrategy, profile: LabRrMode): LedgerKey => `${strategy}:${profile}`;

export function createBook(now: number): LedgerBook {
  const ledgers: Record<string, Ledger> = {};
  for (const strategy of LAB_STRATEGIES) for (const profile of LEDGER_PROFILES) {
    const key = ledgerKey(strategy, profile);
    ledgers[key] = { key, strategy, profile, start_balance: LEDGER_START_BALANCE, started_at: now, state: emptyLab() };
  }
  return { version: "lab-ledgers-v1", started_at: now, ledgers };
}

/** Adds any ledger missing from a stored book (e.g. new modes) at $50, started now; existing ledgers untouched. */
export function upgradeBook(b: LedgerBook, now: number): LedgerBook {
  const ledgers = { ...b.ledgers };
  let added = false;
  for (const strategy of LAB_STRATEGIES) for (const profile of LEDGER_PROFILES) {
    const key = ledgerKey(strategy, profile);
    if (!ledgers[key]) { ledgers[key] = { key, strategy, profile, start_balance: LEDGER_START_BALANCE, started_at: now, state: emptyLab() }; added = true; }
  }
  for (const profile of LEDGER_PROFILES) {
    const key = ledgerKey("TOUCH_SNR", profile), l = ledgers[key];
    if (l && !(l.topups ?? []).some((t) => t.id === TOUCH_TOPUP.id)) { ledgers[key] = { ...l, topups: [...(l.topups ?? []), { ...TOUCH_TOPUP, at: now }] }; added = true; }
  }
  return added ? { ...b, ledgers } : b;
}

/** Each signal goes only to its own strategy's ledgers, once per profile. Dedup stays per ledger (existing key). */
export function bookOpen(b: LedgerBook, symbol: string, signals: readonly LabSignal[], q: LabQuote, now: number): LedgerBook {
  const ledgers = { ...b.ledgers };
  for (const l of Object.values(b.ledgers)) {
    const mine = signals.filter((s) => s.strategy === l.strategy);
    if (mine.length) ledgers[l.key] = { ...l, state: openSignals(l.state, symbol, mine, q, now, l.profile) };
  }
  return { ...b, ledgers };
}

export function bookMark(b: LedgerBook, symbol: string, q: LabQuote, now: number): LedgerBook {
  let changed = false;
  const ledgers: Record<string, Ledger> = {};
  for (const l of Object.values(b.ledgers)) {
    const state = markSymbol(l.state, symbol, q, now);
    if (state !== l.state) changed = true;
    ledgers[l.key] = state === l.state ? l : { ...l, state };
  }
  return changed ? { ...b, ledgers } : b;
}

export interface LedgerStats {
  key: LedgerKey; strategy: LabStrategy; profile: LabRrMode; start_balance: number; started_at: number;
  balance: number; equity: number; realized: number; floating: number; open: number;
  closed: number; wins: number; losses: number; breakeven: number; winRate: number | null;
  exits: { TP: number; SL: number; TRAIL: number; OTHER: number };
  maxDrawdown: number; depletedAt: number | null; topupTotal: number; capitalIn: number; topups: readonly LedgerTopup[];
  openLots: number; openNotionalUsd: number;
}

const BE_EPS = 0.005;

export function ledgerStats(l: Ledger): LedgerStats {
  const trades = l.state.trades;
  const closed = trades.filter((t) => t.status === "CLOSED").sort((a, b) => (a.closed_at ?? 0) - (b.closed_at ?? 0));
  const open = trades.filter((t) => t.status === "OPEN");
  const exits = { TP: 0, SL: 0, TRAIL: 0, OTHER: 0 };
  const topups = l.topups ?? [], topupTotal = topups.reduce((a, t) => a + t.amount, 0);
  let bal = l.start_balance, peak = bal, maxDd = 0, depletedAt: number | null = null;
  for (const t of closed) {
    const r = t.exit_reason; if (r === "TP" || r === "SL" || r === "TRAIL") exits[r]++; else exits.OTHER++;
    bal += t.pnl_usd; peak = Math.max(peak, bal); maxDd = Math.max(maxDd, peak - bal);
    if (depletedAt === null && bal <= 0) depletedAt = t.closed_at;
  }
  const wins = closed.filter((t) => t.pnl_usd > BE_EPS).length, losses = closed.filter((t) => t.pnl_usd < -BE_EPS).length;
  const realized = closed.reduce((a, t) => a + t.pnl_usd, 0), floating = open.reduce((a, t) => a + t.pnl_usd, 0);
  const notional = (t: LabTrade) => t.lot * (LAB_SYMBOLS[t.symbol]?.contract ?? 1) * t.mark;
  return {
    key: l.key, strategy: l.strategy, profile: l.profile, start_balance: l.start_balance, started_at: l.started_at,
    balance: l.start_balance + topupTotal + realized, equity: l.start_balance + topupTotal + realized + floating, topupTotal, capitalIn: l.start_balance + topupTotal, topups, realized, floating, open: open.length,
    closed: closed.length, wins, losses, breakeven: closed.length - wins - losses,
    winRate: wins + losses ? wins / (wins + losses) : null, exits, maxDrawdown: maxDd, depletedAt,
    openLots: open.reduce((a, t) => a + t.lot, 0), openNotionalUsd: open.reduce((a, t) => a + notional(t), 0),
  };
}

export const bookStats = (b: LedgerBook): LedgerStats[] =>
  LAB_STRATEGIES.flatMap((s) => LEDGER_PROFILES.map((p) => b.ledgers[ledgerKey(s, p)]).filter((l): l is Ledger => !!l).map(ledgerStats));
