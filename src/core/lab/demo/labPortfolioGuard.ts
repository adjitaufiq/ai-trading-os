/**
 * Lab DEMO portfolio guard — pure, signed P/L against the broker-day BASELINE (no abs()).
 *
 *   per trade dayBase  = broker profit mark at day start (0 when opened today)
 *   realized today     = Σ closed-today (deal net − dayBase)
 *   floating today     = Σ open (broker profit [+swap] − dayBase)
 *   day P/L            = realized + floating                         → target / stop triggers
 *   worst-case today   = realized + Σ open (P/L at BROKER hard SL − dayBase) − friction × open
 *                                                                     → entry budget gate
 * A runner-side trailing floor is NOT counted: only the SL the broker actually holds. Floating loss is never
 * added on top of SL risk (the SL scenario replaces the floating mark), so nothing is counted twice.
 */
export interface GuardTrade {
  readonly ticket: number; readonly symbol: string; readonly side: "BUY" | "SELL"; readonly volume: number;
  readonly dayBaseUsd: number; readonly closedDay: string | null; readonly pnlUsd: number | null; readonly open: boolean;
}
export interface GuardPos { readonly ticket: number; readonly priceOpen: number | null; readonly sl: number | null; readonly profit: number | null; readonly swap: number | null; readonly volume: number }
export interface GuardSpec { readonly tickSize: number; readonly tickValue: number }

export const usdAtPrice = (side: "BUY" | "SELL", entry: number, px: number, volume: number, spec: GuardSpec) =>
  ((side === "BUY" ? px - entry : entry - px) / spec.tickSize) * spec.tickValue * volume;

export interface DayPnl {
  readonly realizedUsd: number;
  readonly floatingUsd: number | null;
  readonly dayPnlUsd: number | null;
  readonly worstCaseUsd: number | null;
  readonly openCount: number;
  /** Open-position commissions are not reported by MT5 until exit: always true while positions are open. */
  readonly costsIncomplete: boolean;
  readonly unmeasurable: readonly number[];
}

export function computeDayPnl(trades: readonly GuardTrade[], positions: readonly GuardPos[], specs: Readonly<Record<string, GuardSpec | null>>, day: string, frictionPerPos: number): DayPnl {
  let realized = 0, floating = 0, worst = 0, n = 0;
  const bad: number[] = [];
  for (const t of trades) {
    if (!t.open && t.closedDay === day && t.pnlUsd != null) realized += t.pnlUsd - t.dayBaseUsd;
    if (!t.open) continue;
    n++;
    const p = positions.find((x) => x.ticket === t.ticket), spec = specs[t.symbol];
    if (!p || p.profit == null || p.priceOpen == null || p.sl == null || !(p.sl > 0) || !spec) { bad.push(t.ticket); continue; }
    const swap = p.swap ?? 0;
    floating += p.profit + swap - t.dayBaseUsd;
    worst += usdAtPrice(t.side, p.priceOpen, p.sl, p.volume, spec) + swap - t.dayBaseUsd;
  }
  const ok = bad.length === 0;
  return {
    realizedUsd: realized, floatingUsd: ok ? floating : null, dayPnlUsd: ok ? realized + floating : null,
    worstCaseUsd: ok ? realized + worst - frictionPerPos * n : null, openCount: n, costsIncomplete: n > 0, unmeasurable: bad,
  };
}

/** Entry allowed only if worst-case after the candidate (its SL loss + one friction buffer) stays above −stop. */
export function budgetAllows(worstCaseUsd: number | null, candidateSlLossUsd: number, frictionPerPos: number, stopUsd: number): { ok: boolean; projectedUsd: number | null } {
  if (worstCaseUsd == null || !(candidateSlLossUsd >= 0)) return { ok: false, projectedUsd: null };
  const projected = worstCaseUsd - candidateSlLossUsd - frictionPerPos;
  return { ok: projected > -stopUsd, projectedUsd: projected };
}

export type LabPhase = "TRADING" | "TARGET_REACHED_HALT" | "PORTFOLIO_STOP_HIT" | "STATE_DESYNC_HALT";
/** Phase transition for one tick. STATE_DESYNC_HALT is sticky (operator clears it); TARGET/STOP last the broker day. */
export function nextPhase(prev: { phase: LabPhase; day: string | null }, day: string, dayPnlUsd: number | null, targetUsd: number, stopUsd: number): LabPhase {
  if (prev.phase === "STATE_DESYNC_HALT") return prev.phase;
  const base: LabPhase = prev.day === day ? prev.phase : "TRADING";
  if (base === "PORTFOLIO_STOP_HIT") return base;
  if (dayPnlUsd != null && dayPnlUsd <= -stopUsd) return "PORTFOLIO_STOP_HIT";
  if (base === "TARGET_REACHED_HALT") return base;
  if (dayPnlUsd != null && dayPnlUsd >= targetUsd) return "TARGET_REACHED_HALT";
  return "TRADING";
}
