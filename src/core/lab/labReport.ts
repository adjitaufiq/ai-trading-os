// Pure, descriptive Strategy Lab report (PAPER). Copies ledger numbers only; never feeds any decision.
import { LAB_LABELS, type LabStrategy } from "./strategies";
import { leaderboard, LAB_START_BALANCE, type LabRow, type LabState } from "./labLedger";
import type { ModeSwitches } from "./modeSwitch";

export const RECENT_WINDOW_MS = 3 * 3600 * 1000;
export const STACKING_OPEN_THRESHOLD = 2;

export interface LabReportRow extends LabRow { on: boolean; recentTrades: number; recentWins: number; recentPnl: number; avgWin: number | null; avgLoss: number | null; rr: number | null; maxDd: number }
export interface LabReport {
  at: number; balance: number; equity: number; realized: number; floating: number; open: number; closed: number;
  recent: { trades: number; wins: number; pnl: number };
  rows: LabReportRow[]; off: LabStrategy[]; leaders: LabReportRow[]; worstOn: LabReportRow | null; stacking: LabReportRow[];
  rrCounts: { NORMAL: number; COPET: number };
  avgWin: number | null; avgLoss: number | null; rr: number | null; maxDd: number; maxDdPct: number;
}

/** Realized-balance drawdown: closed trades in close order, peak → lowest later trough (USD, ≥0). */
export function maxDrawdown(closedPnls: number[], start = 0): { usd: number; pct: number } {
  let bal = start, peak = start, dd = 0, ddPct = 0;
  for (const p of closedPnls) { bal += p; if (bal > peak) peak = bal; const d = peak - bal; if (d > dd) { dd = d; ddPct = peak > 0 ? d / peak : 0; } }
  return { usd: dd, pct: ddPct };
}

export function winLossStats(pnls: number[]): { avgWin: number | null; avgLoss: number | null; rr: number | null } {
  const w = pnls.filter((p) => p > 0), l = pnls.filter((p) => p <= 0);
  const avgWin = w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  const avgLoss = l.length ? Math.abs(l.reduce((a, b) => a + b, 0) / l.length) : null;
  return { avgWin, avgLoss, rr: avgWin != null && avgLoss ? avgWin / avgLoss : null };
}

export function buildLabReport(state: LabState, switches: ModeSwitches, now: number, operator: OperatorSettings | null = null): LabReport {
  const board = leaderboard(state);
  const since = now - RECENT_WINDOW_MS;
  const rows: LabReportRow[] = board.rows.map((r) => {
    const recent = state.trades.filter((t) => t.strategy === r.strategy && t.status === "CLOSED" && t.closed_at != null && t.closed_at >= since);
    const closed = state.trades.filter((t) => t.strategy === r.strategy && t.status === "CLOSED").sort((a, b) => (a.closed_at ?? 0) - (b.closed_at ?? 0)).map((t) => t.pnl_usd);
    return { ...r, ...winLossStats(closed), maxDd: maxDrawdown(closed).usd, on: switches[r.strategy], recentTrades: recent.length, recentWins: recent.filter((t) => t.pnl_usd > 0).length, recentPnl: recent.reduce((a, t) => a + t.pnl_usd, 0) };
  });
  const onRows = rows.filter((r) => r.on);
  const losers = onRows.filter((r) => r.realized < 0).sort((a, b) => a.realized - b.realized);
  const rr = { NORMAL: 0, COPET: 0 };
  for (const t of state.trades) rr[t.rr_mode ?? "NORMAL"]++;
  const allClosed = state.trades.filter((t) => t.status === "CLOSED").sort((a, b) => (a.closed_at ?? 0) - (b.closed_at ?? 0)).map((t) => t.pnl_usd);
  const dd = maxDrawdown(allClosed, LAB_START_BALANCE);
  return {
    at: now, balance: board.balance, equity: board.equity, realized: board.balance - LAB_START_BALANCE, floating: board.equity - board.balance,
    open: rows.reduce((a, r) => a + r.open, 0), closed: rows.reduce((a, r) => a + r.trades, 0),
    recent: { trades: rows.reduce((a, r) => a + r.recentTrades, 0), wins: rows.reduce((a, r) => a + r.recentWins, 0), pnl: rows.reduce((a, r) => a + r.recentPnl, 0) },
    rows, off: rows.filter((r) => !r.on).map((r) => r.strategy),
    leaders: onRows.filter((r) => r.realized > 0).slice(0, 2), worstOn: losers[0] ?? null,
    stacking: rows.filter((r) => r.open > STACKING_OPEN_THRESHOLD), rrCounts: rr,
    ...winLossStats(allClosed), maxDd: dd.usd, maxDdPct: dd.pct,
  };
}

const usd = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const money = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const ratio = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)} : 1`);
const pct = (w: number, n: number) => (n ? `${((w / n) * 100).toFixed(1)}%` : "—");

export function formatLabReport(r: LabReport, header?: string[] | string): string {
  const when = new Date(r.at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour12: false, dateStyle: "medium", timeStyle: "short" });
  const kind = typeof header === "string" ? header : null;
  const medal = (i: number) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "▫️");
  const rows = r.rows.flatMap((x, i) => [
    `${medal(i)} #${i + 1} · Mode ${LAB_LABELS[x.strategy]} [${x.on ? "ON" : "OFF"}]`,
    `   Net ${usd(x.realized)} · ${x.wins}W/${x.losses}L (${pct(x.wins, x.trades)}) · ${x.trades} trade`,
    `   Open ${x.open} (float ${usd(x.floating)}) · 3j ${x.recentTrades} trade ${usd(x.recentPnl)}`,
    `   AvgW ${money(x.avgWin)} · AvgL ${money(x.avgLoss)} · RR ${ratio(x.rr)} · DD -$${x.maxDd.toFixed(2)}`,
    "",
  ]);
  const L: string[] = [
    ...(Array.isArray(header) ? header : []),
    "📊 STRATEGY LAB REPORT",
    `🕒 ${when} WIB${kind ? ` · ${kind}` : ""}`,
    "⚠️ SIMULASI PAPER — bukan order/profit broker MT5",
    "Ledger gabungan $500 di browser ini; biaya/spread/komisi tidak dihitung",
    "",
    "📈 STATUS GLOBAL",
    `• Balance $${r.balance.toFixed(2)} · Equity $${r.equity.toFixed(2)}`,
    `• Realized ${usd(r.realized)} · Floating ${usd(r.floating)}`,
    `• Open ${r.open} · Closed ${r.closed}`,
    `• AvgW ${money(r.avgWin)} · AvgL ${money(r.avgLoss)} · RR ${ratio(r.rr)}`,
    `• Max DD -$${r.maxDd.toFixed(2)} (${(r.maxDdPct * 100).toFixed(1)}% dari peak, realized)`,
    `• 3 jam: ${r.recent.trades} closed · ${r.recent.wins}W/${r.recent.trades - r.recent.wins}L (${pct(r.recent.wins, r.recent.trades)}) · ${usd(r.recent.pnl)}`,
    "",
    "🏆 LEADERBOARD (urut Realized P/L)",
    "",
    ...rows,
    "📌 MODE OFF",
    r.off.length ? r.off.map((m) => `Mode ${LAB_LABELS[m]}`).join("\n") : "(tidak ada)",
    "",
    "🧠 DIAGNOSTIK (aturan sederhana, bukan AI)",
    `• Mesin cuan: ${r.leaders.length ? r.leaders.map((x) => `Mode ${LAB_LABELS[x.strategy]} ${usd(x.realized)}`).join(" & ") : "belum ada mode ON yang profit"}`,
    `• Paling merugikan (ON): ${r.worstOn ? `Mode ${LAB_LABELS[r.worstOn.strategy]} ${usd(r.worstOn.realized)}` : "tidak ada"}`,
    `• Stacking >${STACKING_OPEN_THRESHOLD} open: ${r.stacking.length ? `Ya — ${r.stacking.map((x) => `Mode ${LAB_LABELS[x.strategy]} (${x.open})`).join(", ")}` : "Tidak"}`,
    "• Karakter market: tidak dihitung otomatis (cek chart)",
    "",
    "⚙️ PARAMETER",
    "• Max open per mode: tanpa batas",
    `• Exit profile: NORMAL ${r.rrCounts.NORMAL} · COPET ${r.rrCounts.COPET} trade`,
  ];
  return L.join("\n");
}
