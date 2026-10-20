// Lab trading report (read-only copy): builds an .xlsx workbook from rows already stored in the cloud.
// Never computes signals, never edits history; unavailable data is labelled NOT_AVAILABLE / NOT_RECORDED.
import * as XLSX from "xlsx";

export const LAB_REPORT_VERSION = "lab-report-v1";
export const NA = "NOT_AVAILABLE";
export const NR = "NOT_RECORDED";

export interface TradeRow { session_id: string; trade_id: string; strategy: string; symbol: string; side: string; status: string; pnl_usd: number; opened_at_ms: number; closed_at_ms: number | null; revision: number; payload: Record<string, unknown>; source: string }
export interface SessionRow { id: string; source: string; started_at_ms: number | null; initial_balance: number; client_as_of_ms: number; synced_at: string; summary: Record<string, unknown> }
export interface EventRow { source: string; at: string; symbol: string | null; type: string; stage: string | null; signal_id: string | null; direction: string | null; reason: string; result: string | null; block_reason: string | null }
export interface ReportInput { trades: TradeRow[]; rawTradeRows: number; sessions: SessionRow[]; signals: EventRow[]; risk: EventRow[]; demoTradeRows: number; notes: string[]; cutoffMs: number }

const WIB = 7 * 3600_000;
export const wib = (ms: number | null | undefined) => (ms == null ? "" : new Date(ms + WIB).toISOString().replace("T", " ").slice(0, 19));
export const wibHour = (ms: number) => new Date(ms + WIB).getUTCHours();
export const wibDate = (ms: number) => new Date(ms + WIB).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (v == null || v === "" ? null : String(v));

/** Dedup: one row per (source, trade_id), highest revision wins (OPEN→CLOSED updates in place). */
export function dedupTrades(rows: TradeRow[]): TradeRow[] {
  const m = new Map<string, TradeRow>();
  for (const r of rows) { const k = `${r.source}|${r.trade_id}`; const p = m.get(k); if (!p || r.revision > p.revision) m.set(k, r); }
  return [...m.values()].sort((a, b) => a.opened_at_ms - b.opened_at_ms);
}

export interface Agg { trades: number; wins: number; losses: number; gross_profit: number; gross_loss: number; net: number; win_rate: number | null; avg_win: number | null; avg_loss: number | null }
export function aggregate(rows: TradeRow[]): Agg {
  const c = rows.filter((t) => t.status === "CLOSED");
  const w = c.filter((t) => t.pnl_usd > 0), l = c.filter((t) => t.pnl_usd < 0);
  const gp = w.reduce((s, t) => s + t.pnl_usd, 0), gl = l.reduce((s, t) => s + t.pnl_usd, 0);
  return { trades: c.length, wins: w.length, losses: l.length, gross_profit: r2(gp), gross_loss: r2(gl), net: r2(gp + gl), win_rate: c.length ? r2((w.length / c.length) * 100) : null, avg_win: w.length ? r2(gp / w.length) : null, avg_loss: l.length ? r2(gl / l.length) : null };
}

/** Max drawdown of the realized equity curve, ordered by close time. */
export function maxDrawdown(rows: TradeRow[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const t of rows.filter((x) => x.status === "CLOSED" && x.closed_at_ms != null).sort((a, b) => a.closed_at_ms! - b.closed_at_ms!)) { eq += t.pnl_usd; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return r2(dd);
}

function groupBy<T>(rows: T[], key: (r: T) => string) { const m = new Map<string, T[]>(); for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; }
const aggRow = (label: Record<string, unknown>, a: Agg) => ({ ...label, ...a, win_rate: a.win_rate ?? NA, avg_win: a.avg_win ?? NA, avg_loss: a.avg_loss ?? NA });

export interface ReportSummary { cutoff_wib: string; sources: string[]; first_trade_wib: string; last_trade_wib: string; raw_rows: number; unique_trades: number; open: number; total: Agg; floating: number | null; max_dd: number; bySymbol: Record<string, Agg>; byMode: [string, Agg][]; bestHour: string; worstHour: string }

export function summarize(inp: ReportInput): ReportSummary {
  const t = inp.trades;
  const closed = t.filter((x) => x.status === "CLOSED");
  const open = t.filter((x) => x.status === "OPEN");
  const fl = open.map((x) => num(x.payload["pnl_usd"]) ?? num(x.payload["floating_usd"]));
  const hours = [...groupBy(closed.filter((x) => x.closed_at_ms), (x) => String(wibHour(x.closed_at_ms!)).padStart(2, "0"))].map(([h, r]) => [h, aggregate(r).net] as const).sort((a, b) => b[1] - a[1]);
  return {
    cutoff_wib: wib(inp.cutoffMs), sources: [...new Set(t.map((x) => x.source))],
    first_trade_wib: t.length ? wib(t[0]!.opened_at_ms) : NA, last_trade_wib: t.length ? wib(Math.max(...t.map((x) => x.closed_at_ms ?? x.opened_at_ms))) : NA,
    raw_rows: inp.rawTradeRows, unique_trades: t.length, open: open.length, total: aggregate(t),
    floating: open.length && fl.every((v) => v != null) ? r2(fl.reduce((s, v) => s + v!, 0)) : open.length ? null : 0,
    max_dd: maxDrawdown(t),
    bySymbol: Object.fromEntries([...groupBy(t, (x) => x.symbol)].map(([k, r]) => [k, aggregate(r)])),
    byMode: [...groupBy(t, (x) => x.strategy)].map(([k, r]) => [k, aggregate(r)] as [string, Agg]).sort((a, b) => b[1].net - a[1].net),
    bestHour: hours[0] ? `${hours[0][0]}:00 WIB (${hours[0][1]})` : NA, worstHour: hours.length ? `${hours[hours.length - 1]![0]}:00 WIB (${hours[hours.length - 1]![1]})` : NA,
  };
}

export function buildWorkbook(inp: ReportInput): { bytes: Uint8Array; summary: ReportSummary } {
  const s = summarize(inp), t = inp.trades, closed = t.filter((x) => x.status === "CLOSED" && x.closed_at_ms != null);
  const wb = XLSX.utils.book_new();
  const add = (name: string, rows: Record<string, unknown>[], empty: string) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ status: NA, reason: empty }]), name);

  // Daily realized + cumulative
  let cum = 0;
  const daily = [...groupBy(closed, (x) => `${x.source}|${wibDate(x.closed_at_ms!)}`)].sort().map(([k, r]) => { const a = aggregate(r); cum += a.net; const [source, date] = k.split("|"); return { date_wib: date, source, ...a, win_rate: a.win_rate ?? NA, avg_win: a.avg_win ?? NA, avg_loss: a.avg_loss ?? NA, cumulative_net: r2(cum) }; });
  const dash: (string | number)[][] = [
    ["Lab Trading Report", LAB_REPORT_VERSION], ["Cutoff (WIB)", s.cutoff_wib], ["Sumber data", s.sources.join(", ") || NA],
    ["Rentang data (WIB)", `${s.first_trade_wib} → ${s.last_trade_wib}`], ["Baris sumber", s.raw_rows], ["Trade unik", s.unique_trades], ["Posisi OPEN", s.open],
    ["Closed trades", s.total.trades], ["Win", s.total.wins], ["Loss", s.total.losses], ["Win rate %", s.total.win_rate ?? NA],
    ["Gross profit $", s.total.gross_profit], ["Gross loss $", s.total.gross_loss], ["Net realized $", s.total.net], ["Floating $", s.floating ?? NA], ["Max drawdown realized $", s.max_dd],
    ["Jam terbaik", s.bestHour], ["Jam terburuk", s.worstHour], [],
    ["Simbol", "trades", "wins", "losses", "win_rate", "gross_profit", "gross_loss", "net"],
    ...Object.entries(s.bySymbol).map(([k, a]) => [k, a.trades, a.wins, a.losses, a.win_rate ?? NA, a.gross_profit, a.gross_loss, a.net]), [],
    ["Mode", "trades", "wins", "losses", "win_rate", "gross_profit", "gross_loss", "net"],
    ...s.byMode.map(([k, a]) => [k, a.trades, a.wins, a.losses, a.win_rate ?? NA, a.gross_profit, a.gross_loss, a.net]), [],
    ["Tanggal WIB", "sumber", "trades", "net", "kumulatif"], ...daily.map((d) => [d.date_wib!, d.source!, d.trades, d.net, d.cumulative_net]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dash), "Dashboard");

  add("Trades_Raw", t.map((x) => {
    const p = x.payload;
    const q: string[] = [];
    if (num(p["entry"]) == null) q.push("NO_ENTRY_PRICE");
    if (x.status === "CLOSED" && num(p["exit_price"]) == null) q.push("NO_EXIT_PRICE");
    return {
      trade_id: x.trade_id, session_id: x.session_id, source: x.source, symbol: x.symbol, mode: x.strategy, strategy_version: str(p["version"]) ?? NR, side: x.side,
      entry_wib: wib(x.opened_at_ms), exit_wib: wib(x.closed_at_ms), duration_min: x.closed_at_ms ? r2((x.closed_at_ms - x.opened_at_ms) / 60000) : "",
      entry_price: num(p["entry"]) ?? NR, exit_price: num(p["exit_price"]) ?? (x.status === "OPEN" ? "" : NR), volume: num(p["lot"]) ?? num(p["volume"]) ?? NR,
      initial_sl: num(p["sl"]) ?? NR, tp: num(p["tp"]) ?? NR, sl_changes: NR, trail_floor_usd: num(p["trail_floor_usd"]) ?? NR, rr_mode: str(p["rr_mode"]) ?? NR,
      gross_pnl: x.source === "BROWSER_PAPER" ? NA : num(p["gross_usd"]) ?? NA, commission: num(p["commission"]) ?? NA, swap: num(p["swap"]) ?? NA, net_pnl: x.pnl_usd,
      status: x.status, exit_reason: str(p["exit_reason"]) ?? (x.status === "OPEN" ? "" : NR), peak_profit_usd: num(p["peak_pnl_usd"]) ?? NR, max_dd_trade: NR,
      entry_reason: str(p["why"]) ?? NR, revision: x.revision, signal_bar_wib: wib(num(p["signal_bar_time"])), data_quality: q.join(",") || "OK",
    };
  }), "Tidak ada trade");

  add("Sessions", inp.sessions.map((x) => { const st = t.filter((y) => y.session_id === x.id); const a = aggregate(st); return { session_id: x.id, source: x.source, started_wib: wib(x.started_at_ms), last_client_wib: wib(x.client_as_of_ms), synced_at: x.synced_at, initial_balance: x.initial_balance, balance: num(x.summary["balance"]) ?? NA, equity: num(x.summary["equity"]) ?? NA, trades: st.length, closed: a.trades, net: a.net, status: st.some((y) => y.status === "OPEN") ? "HAS_OPEN" : "IDLE" }; }), "Tidak ada sesi");

  // Hourly realized buckets (derived from closed trades). Floating/peak/guard not snapshotted historically.
  let hc = 0, hp = 0;
  add("Hourly_Snapshots", [...groupBy(closed, (x) => `${wibDate(x.closed_at_ms!)} ${String(wibHour(x.closed_at_ms!)).padStart(2, "0")}:00`)].sort().map(([k, r]) => { const a = aggregate(r); hc += a.net; hp = Math.max(hp, hc); return { hour_wib: k, closed_trades: a.trades, realized: a.net, cumulative_realized: r2(hc), peak_cumulative: r2(hp), drawdown_from_peak: r2(hc - hp), open_positions: NR, floating_pnl: NR, risk_guard_status: NR }; }), "Tidak ada trade closed");

  add("Position_Snapshots", t.filter((x) => x.status === "OPEN").map((x) => ({ trade_id: x.trade_id, source: x.source, symbol: x.symbol, mode: x.strategy, side: x.side, opened_wib: wib(x.opened_at_ms), age_min: r2((inp.cutoffMs - x.opened_at_ms) / 60000), entry: num(x.payload["entry"]) ?? NR, sl_active: num(x.payload["sl"]) ?? NR, trail_floor_usd: num(x.payload["trail_floor_usd"]) ?? NR, floating_pnl: num(x.payload["pnl_usd"]) ?? NR, snapshot_note: "Hanya posisi OPEN pada cutoff; snapshot historis posisi belum dicatat (NOT_RECORDED)." })), "Tidak ada posisi OPEN pada cutoff; riwayat snapshot posisi belum pernah dicatat");

  add("Signal_Log", inp.signals.map((e) => ({ at: e.at, source: e.source, symbol: e.symbol ?? "", type: e.type, stage: e.stage ?? "", signal_id: e.signal_id ?? "", direction: e.direction ?? "", reason: e.reason || NR, result: e.result ?? "", block_reason: e.block_reason ?? "" })), "Log sinyal Lab Paper tidak dicatat; alasan entry Paper hanya ada di kolom entry_reason Trades_Raw");
  add("Risk_Events", inp.risk.map((e) => ({ at: e.at, source: e.source, symbol: e.symbol ?? "", type: e.type, reason: e.reason || NR, block_reason: e.block_reason ?? "", result: e.result ?? "" })), "Risk guard Paper (target/stop/blackout/cap) tidak pernah dicatat sebagai event");

  add("Mode_Performance", [...groupBy(t, (x) => `${x.source}|${x.strategy}|${x.symbol}`)].sort().map(([k, r]) => { const [source, mode, symbol] = k.split("|"); return aggRow({ source, mode, symbol }, aggregate(r)); }), "Tidak ada trade");
  add("Hourly_Performance", [...groupBy(closed, (x) => `${wibDate(x.closed_at_ms!)}|${String(wibHour(x.closed_at_ms!)).padStart(2, "0")}|${x.symbol}|${x.strategy}`)].sort().map(([k, r]) => { const [date, hour, symbol, mode] = k.split("|"); return aggRow({ date_wib: date, hour_wib: `${hour}:00`, symbol, mode }, aggregate(r)); }), "Tidak ada trade closed");

  const sumPnl = r2(t.filter((x) => x.status === "CLOSED").reduce((a, x) => a + x.pnl_usd, 0));
  add("Data_Quality", [
    { check: "lab_journal_trades baris mentah", value: inp.rawTradeRows }, { check: "Trade unik (source+trade_id, revisi tertinggi)", value: t.length },
    { check: "Duplikat/revisi lama dibuang", value: inp.rawTradeRows - t.length }, { check: "Sesi", value: inp.sessions.length },
    { check: "MT5_DEMO trade rows (lab_demo_trades)", value: inp.demoTradeRows }, { check: "Rekonsiliasi net realized (jumlah pnl closed)", value: sumPnl },
    { check: "Net di Dashboard", value: s.total.net }, { check: "Selisih", value: r2(sumPnl - s.total.net) },
    { check: "Trade tanpa harga entry", value: t.filter((x) => num(x.payload["entry"]) == null).length },
    { check: "Rentang (WIB)", value: `${s.first_trade_wib} → ${s.last_trade_wib}` },
    ...inp.notes.map((n) => ({ check: "Catatan", value: n })),
  ], "");

  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return { bytes: new Uint8Array(bytes), summary: s };
}

export function telegramSummary(s: ReportSummary, fileOk: boolean): string {
  const f = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `−$${Math.abs(n).toFixed(2)}`);
  const L = [
    `<b>📊 Lab Report · ${s.cutoff_wib} WIB</b>`, `Sumber: ${s.sources.join(", ") || NA} (simulasi, bukan order broker)`, `Rentang: ${s.first_trade_wib} → ${s.last_trade_wib}`,
    `Trade: ${s.total.trades} closed · ${s.total.wins}W/${s.total.losses}L · WR ${s.total.win_rate ?? "-"}% · OPEN ${s.open}`,
    `Realized: ${f(s.total.net)} · Floating: ${s.floating == null ? NA : f(s.floating)}`, `Gross: ${f(s.total.gross_profit)} / ${f(s.total.gross_loss)} · MaxDD ${f(s.max_dd)}`, "",
    ...Object.entries(s.bySymbol).map(([k, a]) => `${k}: ${a.trades} tr · WR ${a.win_rate ?? "-"}% · ${f(a.net)}`), "",
    "<b>Mode</b>", ...s.byMode.slice(0, 12).map(([k, a]) => `${k}: ${a.trades} · ${f(a.net)}`), "",
    `Jam terbaik: ${s.bestHour}`, `Jam terburuk: ${s.worstHour}`,
    `Daily guard/peak/trailing: ${NR} (Paper tidak mencatat event guard)`, `Kualitas data: ${s.raw_rows} baris → ${s.unique_trades} unik`,
    `Excel: ${fileOk ? "terlampir" : "GAGAL dibuat"}`,
  ];
  return L.join("\n");
}
