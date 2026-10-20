// Lab trading report (read-only copy): builds an .xlsx workbook from rows already stored in the cloud.
// Never computes signals, never edits history; unavailable data is labelled NOT_AVAILABLE / NOT_RECORDED / NOT_APPLICABLE.
// All aggregation runs at full precision; rounding happens only when a value is written to a sheet or a message.
import * as XLSX from "xlsx";

export const LAB_REPORT_VERSION = "lab-report-v2";
export const NA = "NOT_AVAILABLE";
export const NR = "NOT_RECORDED";
export const NAPP = "NOT_APPLICABLE";
/** Signal bar older than this before entry is flagged (no cause is inferred). */
export const SIGNAL_LAG_FLAG_MIN = 10;
/** OPEN positions older than this at cutoff are flagged for review (never closed by the report). */
export const LONG_OPEN_FLAG_H = 4;

export interface TradeRow { session_id: string; trade_id: string; strategy: string; symbol: string; side: string; status: string; pnl_usd: number; opened_at_ms: number; closed_at_ms: number | null; revision: number; payload: Record<string, unknown>; source: string }
export interface SessionRow { id: string; source: string; started_at_ms: number | null; initial_balance: number; client_as_of_ms: number; synced_at: string; summary: Record<string, unknown> }
export interface EventRow { source: string; at: string; symbol: string | null; type: string; stage: string | null; signal_id: string | null; direction: string | null; reason: string; result: string | null; block_reason: string | null }
export interface ReportInput { trades: TradeRow[]; rawTradeRows: number; sessions: SessionRow[]; signals: EventRow[]; risk: EventRow[]; arena?: EventRow[]; demoTradeRows: number; notes: string[]; cutoffMs: number }

const WIB = 7 * 3600_000;
export const wib = (ms: number | null | undefined) => (ms == null ? "" : new Date(ms + WIB).toISOString().replace("T", " ").slice(0, 19));
export const wibHour = (ms: number) => new Date(ms + WIB).getUTCHours();
export const wibDate = (ms: number) => new Date(ms + WIB).toISOString().slice(0, 10);
/** Display rounding only. */
export const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const hh = (ms: number) => String(wibHour(ms)).padStart(2, "0");

/** Dedup: one row per (source, trade_id), highest revision wins; equal revision ⇒ later closed/opened time, then first seen. */
export function dedupTrades(rows: TradeRow[]): TradeRow[] {
  const m = new Map<string, TradeRow>();
  for (const r of rows) {
    const k = `${r.source}|${r.trade_id}`; const p = m.get(k);
    if (!p || r.revision > p.revision || (r.revision === p.revision && (r.closed_at_ms ?? 0) > (p.closed_at_ms ?? 0))) m.set(k, r);
  }
  return [...m.values()].sort((a, b) => a.opened_at_ms - b.opened_at_ms || a.trade_id.localeCompare(b.trade_id));
}

/** Full-precision aggregate over CLOSED trades. positive/negative = sums of positive/negative net P&L (not broker gross). */
export interface Agg { trades: number; wins: number; losses: number; flat: number; positive_net_pnl: number; negative_net_pnl: number; net: number; win_rate: number | null; avg_win: number | null; avg_loss: number | null }
export function aggregate(rows: TradeRow[]): Agg {
  const c = rows.filter((t) => t.status === "CLOSED");
  const w = c.filter((t) => t.pnl_usd > 0), l = c.filter((t) => t.pnl_usd < 0);
  const gp = w.reduce((s, t) => s + t.pnl_usd, 0), gl = l.reduce((s, t) => s + t.pnl_usd, 0);
  return { trades: c.length, wins: w.length, losses: l.length, flat: c.length - w.length - l.length, positive_net_pnl: gp, negative_net_pnl: gl, net: c.reduce((s, t) => s + t.pnl_usd, 0), win_rate: c.length ? (w.length / c.length) * 100 : null, avg_win: w.length ? gp / w.length : null, avg_loss: l.length ? gl / l.length : null };
}
const fmtAgg = (a: Agg) => ({ trades: a.trades, wins: a.wins, losses: a.losses, flat: a.flat, positive_net_pnl: r2(a.positive_net_pnl), negative_net_pnl: r2(a.negative_net_pnl), net: r2(a.net), win_rate: a.win_rate == null ? NA : r2(a.win_rate), avg_win: a.avg_win == null ? NA : r2(a.avg_win), avg_loss: a.avg_loss == null ? NA : r2(a.avg_loss) });

/** Max drawdown of the realized equity curve, ordered by close time (full precision). */
export function maxDrawdown(rows: TradeRow[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const t of rows.filter((x) => x.status === "CLOSED" && x.closed_at_ms != null).sort((a, b) => a.closed_at_ms! - b.closed_at_ms! || a.trade_id.localeCompare(b.trade_id))) { eq += t.pnl_usd; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return dd;
}

function groupBy<T>(rows: T[], key: (r: T) => string) { const m = new Map<string, T[]>(); for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; }

/** Opened/closed counts per WIB date: a trade counts once in opened (open date) and once in closed (close date). */
export function openedClosedByDate(rows: TradeRow[]): { date_wib: string; opened_count: number; closed_count: number }[] {
  const m = new Map<string, { o: number; c: number }>();
  const get = (d: string) => m.get(d) ?? m.set(d, { o: 0, c: 0 }).get(d)!;
  for (const t of rows) { get(wibDate(t.opened_at_ms)).o++; if (t.status === "CLOSED" && t.closed_at_ms != null) get(wibDate(t.closed_at_ms)).c++; }
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([date_wib, v]) => ({ date_wib, opened_count: v.o, closed_count: v.c }));
}

/**
 * Data quality (documented criteria):
 *  NOT_RECORDED — a core fact is missing: entry price; for CLOSED also exit price or close time.
 *  COMPLETE     — every REQUIRED field below is present.
 *  PARTIAL      — core facts present, at least one required field missing.
 * Required: entry_price, volume, initial_sl, tp, signal_bar_time, rr_mode; CLOSED: exit_price, exit_reason;
 *   trailing profiles (COPET/FIBO): peak_pnl_usd; exit_reason TRAIL: trail_floor_usd; lifecycle OPENED (+CLOSED when closed).
 * Not applicable (never counted missing): gross P&L/commission/swap for BROWSER_PAPER; trail_floor when exit ≠ TRAIL; NORMAL profile peak.
 */
export const DATA_QUALITY_RULES = [
  "NOT_RECORDED: harga entry tidak ada; untuk CLOSED juga harga exit atau waktu tutup tidak ada.",
  "COMPLETE: semua field wajib ada — entry_price, volume, initial_sl, tp, signal_bar_time, rr_mode; CLOSED: exit_price, exit_reason; profil COPET/FIBO: peak_pnl_usd; exit TRAIL: trail_floor_usd; lifecycle OPENED (+CLOSED bila closed).",
  "PARTIAL: fakta inti ada, tetapi ≥1 field wajib tidak tercatat (lihat missing_fields).",
  "NOT_APPLICABLE (tidak dihitung hilang): gross/komisi/swap untuk BROWSER_PAPER; trail_floor bila exit bukan TRAIL; peak untuk profil NORMAL.",
];
export function dataQuality(t: TradeRow): { status: "COMPLETE" | "PARTIAL" | "NOT_RECORDED"; missing: string[] } {
  const p = t.payload; const closed = t.status === "CLOSED";
  if (num(p["entry"]) == null || (closed && (num(p["exit_price"]) == null || t.closed_at_ms == null))) return { status: "NOT_RECORDED", missing: ["core"] };
  const miss: string[] = [];
  const need = (k: string, ok: boolean) => { if (!ok) miss.push(k); };
  need("volume", num(p["lot"]) != null || num(p["volume"]) != null);
  need("initial_sl", num(p["sl"]) != null); need("tp", num(p["tp"]) != null);
  need("signal_bar_time", num(p["signal_bar_time"]) != null);
  const prof = str(p["exit_profile"]) === "FIBO" ? "FIBO" : str(p["rr_mode"]);
  need("rr_mode", prof != null);
  if (closed) need("exit_reason", str(p["exit_reason"]) != null);
  if (prof === "COPET" || prof === "FIBO") need("peak_pnl_usd", num(p["peak_pnl_usd"]) != null);
  if (closed && str(p["exit_reason"]) === "TRAIL") need("trail_floor_usd", num(p["trail_floor_usd"]) != null);
  const lc = Array.isArray(p["lifecycle"]) ? (p["lifecycle"] as { type?: string }[]) : [];
  need("lifecycle_OPENED", lc.some((e) => e.type === "OPENED"));
  if (closed) need("lifecycle_CLOSED", lc.some((e) => e.type === "CLOSED"));
  return { status: miss.length ? "PARTIAL" : "COMPLETE", missing: miss };
}

/** Lag between signal bar open and entry, minutes; null when signal bar is not recorded. Flag only, never a cause. */
export function signalLagMin(t: TradeRow): number | null { const b = num(t.payload["signal_bar_time"]); return b == null ? null : (t.opened_at_ms - b) / 60000; }

export interface ReportSummary { cutoff_wib: string; sources: string[]; first_trade_wib: string; last_trade_wib: string; raw_rows: number; unique_trades: number; open: number; total: Agg; floating: number | null; max_dd: number; bySymbol: Record<string, Agg>; byMode: [string, Agg][]; mode_trade_sum: number; bestHour: string; worstHour: string; quality: Record<string, number>; lag_flags: number; long_open: number }

export function summarize(inp: ReportInput): ReportSummary {
  const t = inp.trades;
  const closed = t.filter((x) => x.status === "CLOSED");
  const open = t.filter((x) => x.status === "OPEN");
  const fl = open.map((x) => num(x.payload["pnl_usd"]) ?? num(x.payload["floating_usd"]));
  const hours = [...groupBy(closed.filter((x) => x.closed_at_ms), (x) => hh(x.closed_at_ms!))].map(([h, r]) => [h, aggregate(r).net] as const).sort((a, b) => b[1] - a[1]);
  const byMode = [...groupBy(t, (x) => x.strategy)].map(([k, r]) => [k, aggregate(r)] as [string, Agg]).sort((a, b) => b[1].net - a[1].net);
  const quality: Record<string, number> = { COMPLETE: 0, PARTIAL: 0, NOT_RECORDED: 0 };
  for (const x of t) quality[dataQuality(x).status]!++;
  return {
    cutoff_wib: wib(inp.cutoffMs), sources: [...new Set(t.map((x) => x.source))],
    first_trade_wib: t.length ? wib(t[0]!.opened_at_ms) : NA, last_trade_wib: t.length ? wib(Math.max(...t.map((x) => x.closed_at_ms ?? x.opened_at_ms))) : NA,
    raw_rows: inp.rawTradeRows, unique_trades: t.length, open: open.length, total: aggregate(t),
    floating: open.length && fl.every((v) => v != null) ? fl.reduce((s, v) => s + v!, 0) : open.length ? null : 0,
    max_dd: maxDrawdown(t),
    bySymbol: Object.fromEntries([...groupBy(t, (x) => x.symbol)].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => [k, aggregate(r)])),
    byMode, mode_trade_sum: byMode.reduce((s, [, a]) => s + a.trades, 0),
    bestHour: hours[0] ? `${hours[0][0]}:00 WIB (${r2(hours[0][1])})` : NA, worstHour: hours.length ? `${hours[hours.length - 1]![0]}:00 WIB (${r2(hours[hours.length - 1]![1])})` : NA,
    quality, lag_flags: t.filter((x) => { const l = signalLagMin(x); return l != null && l > SIGNAL_LAG_FLAG_MIN; }).length,
    long_open: open.filter((x) => (inp.cutoffMs - x.opened_at_ms) / 3600_000 > LONG_OPEN_FLAG_H).length,
  };
}

/** Per date+hour WIB on one time axis (entry or exit). Contributors = largest |net| symbol and mode in that bucket. */
export function timeAnalysis(rows: TradeRow[], axis: "entry" | "exit") {
  const at = (x: TradeRow) => (axis === "entry" ? x.opened_at_ms : x.closed_at_ms);
  const usable = rows.filter((x) => at(x) != null);
  return [...groupBy(usable, (x) => `${wibDate(at(x)!)}|${hh(at(x)!)}`)].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => {
    const [date, hour] = k.split("|"); const a = aggregate(r);
    const top = (key: (x: TradeRow) => string) => { const g = [...groupBy(r.filter((x) => x.status === "CLOSED"), key)].map(([n, rr]) => [n, aggregate(rr).net] as const).sort((p, q) => Math.abs(q[1]) - Math.abs(p[1]))[0]; return g ? `${g[0]} (${r2(g[1])})` : NA; };
    return { [`${axis}_date_wib`]: date, [`${axis}_hour_wib`]: `${hour}:00`, opened_in_bucket: axis === "entry" ? r.length : r.filter((x) => x.opened_at_ms != null && wibDate(x.opened_at_ms) === date && hh(x.opened_at_ms) === hour).length, closed_in_bucket: a.trades, ...fmtAgg(a), top_symbol: top((x) => x.symbol), top_mode: top((x) => x.strategy) };
  });
}

type Lc = { id?: string; type?: string; at?: number; price?: number | null; pnl_usd?: number | null; peak_pnl_usd?: number | null; trail_floor_usd?: number | null; reason?: string | null; v?: string };

export function buildWorkbook(inp: ReportInput): { bytes: Uint8Array; summary: ReportSummary } {
  const s = summarize(inp), t = inp.trades, closed = t.filter((x) => x.status === "CLOSED" && x.closed_at_ms != null);
  const wb = XLSX.utils.book_new();
  const add = (name: string, rows: Record<string, unknown>[], empty: string) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ status: NR, reason: empty }]), name);

  let cum = 0;
  const oc = new Map(openedClosedByDate(t).map((d) => [d.date_wib, d]));
  const daily = [...groupBy(closed, (x) => `${x.source}|${wibDate(x.closed_at_ms!)}`)].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => { const a = aggregate(r); cum += a.net; const [source, date] = k.split("|"); return { date: date!, source: source!, a, cum }; });
  const T = s.total;
  const dash: (string | number)[][] = [
    ["Lab Trading Report", LAB_REPORT_VERSION], ["Cutoff (WIB)", s.cutoff_wib], ["Sumber data", s.sources.join(", ") || NA],
    ["Rentang data (WIB)", `${s.first_trade_wib} → ${s.last_trade_wib}`], ["Baris sumber", s.raw_rows], ["Trade unik", s.unique_trades], ["Posisi OPEN (tidak dihitung closed)", s.open],
    ["Closed trades", T.trades], ["Win", T.wins], ["Loss", T.losses], ["Flat (P&L 0)", T.flat], ["Win rate %", T.win_rate == null ? NA : r2(T.win_rate)],
    ["Positive Net P&L $ (jumlah trade untung)", r2(T.positive_net_pnl)], ["Negative Net P&L $ (jumlah trade rugi)", r2(T.negative_net_pnl)],
    ["Net realized $", r2(T.net)], ["Floating $ (OPEN, terpisah)", s.floating == null ? NA : r2(s.floating)], ["Max drawdown realized $", r2(s.max_dd)],
    ["Gross P&L broker / komisi / swap", `${NA} (tidak tersedia di data Paper)`],
    ["Jam terbaik (exit)", s.bestHour], ["Jam terburuk (exit)", s.worstHour],
    ["Kualitas data", `COMPLETE ${s.quality["COMPLETE"]} · PARTIAL ${s.quality["PARTIAL"]} · NOT_RECORDED ${s.quality["NOT_RECORDED"]}`],
    ["Flag signal lag >10 menit", s.lag_flags], [`Flag OPEN >${LONG_OPEN_FLAG_H} jam`, s.long_open], [],
    ["Simbol", "trades", "wins", "losses", "win_rate", "positive_net_pnl", "negative_net_pnl", "net"],
    ...Object.entries(s.bySymbol).map(([k, a]) => { const f = fmtAgg(a); return [k, f.trades, f.wins, f.losses, f.win_rate, f.positive_net_pnl, f.negative_net_pnl, f.net]; }), [],
    ["Mode", "trades", "wins", "losses", "win_rate", "positive_net_pnl", "negative_net_pnl", "net"],
    ...s.byMode.map(([k, a]) => { const f = fmtAgg(a); return [k, f.trades, f.wins, f.losses, f.win_rate, f.positive_net_pnl, f.negative_net_pnl, f.net]; }),
    ["Σ mode (cek)", s.mode_trade_sum, "", "", "", "", "", r2(s.byMode.reduce((x, [, a]) => x + a.net, 0))], [],
    ["Tanggal WIB", "sumber", "closed_trades", "net", "kumulatif", "opened_count (tgl buka)", "closed_count (tgl tutup)"],
    ...daily.map((d) => [d.date, d.source, d.a.trades, r2(d.a.net), r2(d.cum), oc.get(d.date)?.opened_count ?? 0, oc.get(d.date)?.closed_count ?? 0]),
    ...[...oc.values()].filter((d) => !daily.some((x) => x.date === d.date_wib)).map((d) => [d.date_wib, "-", 0, 0, "", d.opened_count, d.closed_count]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dash), "Dashboard");

  add("Trades_Raw", t.map((x) => {
    const p = x.payload; const q = dataQuality(x); const lag = signalLagMin(x); const paper = x.source === "BROWSER_PAPER";
    const lc = Array.isArray(p["lifecycle"]) ? (p["lifecycle"] as Lc[]) : [];
    return {
      trade_id: x.trade_id, session_id: x.session_id, source: x.source, symbol: x.symbol, mode: x.strategy, strategy_version: str(p["version"]) ?? NR, side: x.side,
      entry_wib: wib(x.opened_at_ms), exit_wib: wib(x.closed_at_ms), entry_epoch_ms: x.opened_at_ms, exit_epoch_ms: x.closed_at_ms ?? "",
      duration_min: x.closed_at_ms ? r2((x.closed_at_ms - x.opened_at_ms) / 60000) : "",
      entry_price: num(p["entry"]) ?? NR, exit_price: num(p["exit_price"]) ?? (x.status === "OPEN" ? "" : NR), volume: num(p["lot"]) ?? num(p["volume"]) ?? NR,
      initial_sl: num(p["sl"]) ?? NR, tp: num(p["tp"]) ?? NR,
      sl_changes: lc.length ? lc.filter((e) => e.type === "TRAIL_FLOOR_SET").length : NR,
      trail_floor_usd: num(p["trail_floor_usd"]) ?? (x.status === "CLOSED" && str(p["exit_reason"]) !== "TRAIL" ? NAPP : NR), rr_mode: str(p["exit_profile"]) ?? str(p["rr_mode"]) ?? NR,
      gross_pnl: paper ? NAPP : num(p["gross_usd"]) ?? NA, commission: paper ? NAPP : num(p["commission"]) ?? NA, swap: paper ? NAPP : num(p["swap"]) ?? NA, net_pnl: x.pnl_usd,
      status: x.status, exit_reason: str(p["exit_reason"]) ?? (x.status === "OPEN" ? "" : NR), peak_profit_usd: num(p["peak_pnl_usd"]) ?? NR, max_dd_trade: NR,
      entry_reason: str(p["why"]) ?? NR, revision: x.revision,
      signal_bar_wib: wib(num(p["signal_bar_time"])), signal_bar_epoch_ms: num(p["signal_bar_time"]) ?? NR, signal_lag_min: lag == null ? NR : r2(lag),
      timestamp_flag: lag != null && lag > SIGNAL_LAG_FLAG_MIN ? "SIGNAL_BAR_LAG_GT_10MIN" : lag != null && lag < 0 ? "SIGNAL_BAR_AFTER_ENTRY" : "",
      lifecycle_events: lc.length || NR, data_quality: q.status, missing_fields: q.missing.join(","),
    };
  }), "Tidak ada trade");

  add("Sessions", inp.sessions.map((x) => { const st = t.filter((y) => y.session_id === x.id); const a = aggregate(st); return { session_id: x.id, source: x.source, started_wib: wib(x.started_at_ms), last_client_wib: wib(x.client_as_of_ms), synced_at: x.synced_at, initial_balance: x.initial_balance, balance: num(x.summary["balance"]) ?? NA, equity: num(x.summary["equity"]) ?? NA, trades: st.length, closed: a.trades, net: r2(a.net), status: st.some((y) => y.status === "OPEN") ? "HAS_OPEN" : "IDLE" }; }), "Tidak ada sesi");

  let hc = 0, hp = 0;
  add("Hourly_Snapshots", [...groupBy(closed, (x) => `${wibDate(x.closed_at_ms!)} ${hh(x.closed_at_ms!)}:00`)].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => { const a = aggregate(r); hc += a.net; hp = Math.max(hp, hc); return { hour_wib: k, closed_trades: a.trades, realized: r2(a.net), cumulative_realized: r2(hc), peak_cumulative: r2(hp), drawdown_from_peak: r2(hc - hp), open_positions: NR, floating_pnl: NR, risk_guard_status: NR }; }), "Tidak ada trade closed");

  const asOf = new Map(inp.sessions.map((x) => [x.id, x.client_as_of_ms]));
  add("Position_Snapshots", t.filter((x) => x.status === "OPEN").map((x) => {
    const ageH = (inp.cutoffMs - x.opened_at_ms) / 3600_000; const snap = asOf.get(x.session_id);
    return { trade_id: x.trade_id, source: x.source, symbol: x.symbol, mode: x.strategy, side: x.side, opened_wib: wib(x.opened_at_ms), age_hours_at_cutoff: r2(ageH), entry: num(x.payload["entry"]) ?? NR, sl_active: num(x.payload["sl"]) ?? NR, tp: num(x.payload["tp"]) ?? NR, trail_floor_usd: num(x.payload["trail_floor_usd"]) ?? NR, floating_pnl: num(x.payload["pnl_usd"]) ?? NR, floating_as_of_wib: snap ? wib(snap) : NR, review_flag: ageH > LONG_OPEN_FLAG_H ? `OPEN_GT_${LONG_OPEN_FLAG_H}H_REVIEW` : "", note: "Hanya fakta tercatat; penyebab posisi masih OPEN tidak disimpulkan. Report tidak menutup posisi." };
  }), "Tidak ada posisi OPEN pada cutoff");

  add("Signal_Log", inp.signals.map((e) => ({ at: e.at, source: e.source, symbol: e.symbol ?? "", type: e.type, stage: e.stage ?? "", signal_id: e.signal_id ?? "", direction: e.direction ?? "", reason: e.reason || NR, result: e.result ?? "", block_reason: e.block_reason ?? "" })), "Belum ada evaluasi Strategy Lab tercatat (instrumentasi lab-eval-v1 hanya untuk kejadian baru); ARENA ada di sheet Arena_Events");
  add("Risk_Events", inp.risk.map((e) => ({ at: e.at, source: e.source, symbol: e.symbol ?? "", type: e.type, reason: e.reason || NR, block_reason: e.block_reason ?? "", result: e.result ?? "" })), "Belum ada blok/guard Strategy Lab tercatat; ARENA ada di sheet Arena_Events");

  add("Mode_Performance", [...groupBy(t, (x) => `${x.source}|${x.strategy}|${x.symbol}`)].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => { const [source, mode, symbol] = k.split("|"); return { source, mode, symbol, ...fmtAgg(aggregate(r)), open: r.filter((x) => x.status === "OPEN").length }; }), "Tidak ada trade");
  add("Hourly_Performance", [...groupBy(closed, (x) => `${wibDate(x.closed_at_ms!)}|${hh(x.closed_at_ms!)}|${x.symbol}|${x.strategy}`)].sort(([a], [b]) => a.localeCompare(b)).map(([k, r]) => { const [date, hour, symbol, mode] = k.split("|"); return { exit_date_wib: date, exit_hour_wib: `${hour}:00`, symbol, mode, ...fmtAgg(aggregate(r)) }; }), "Tidak ada trade closed");

  const sumPnl = closed.reduce((a, x) => a + x.pnl_usd, 0) + t.filter((x) => x.status === "CLOSED" && x.closed_at_ms == null).reduce((a, x) => a + x.pnl_usd, 0);
  add("Data_Quality", [
    { check: "Baris trade mentah (Paper + DEMO)", value: inp.rawTradeRows }, { check: "Trade unik (source+trade_id, revisi tertinggi)", value: t.length },
    { check: "Duplikat/revisi lama dibuang", value: inp.rawTradeRows - t.length }, { check: "CLOSED", value: T.trades }, { check: "OPEN", value: s.open },
    { check: "CLOSED + OPEN = unik", value: T.trades + s.open === t.length ? "MATCH" : `MISMATCH (${T.trades + s.open} vs ${t.length})` },
    { check: "Σ trade per mode = CLOSED", value: s.mode_trade_sum === T.trades ? "MATCH" : `MISMATCH (${s.mode_trade_sum} vs ${T.trades})` },
    { check: "Sesi", value: inp.sessions.length }, { check: "MT5_DEMO trade rows", value: inp.demoTradeRows },
    { check: "Net realized presisi penuh", value: sumPnl }, { check: "Net realized tampilan (2 desimal)", value: r2(T.net) }, { check: "Selisih (presisi penuh)", value: sumPnl - T.net },
    { check: "Kualitas COMPLETE / PARTIAL / NOT_RECORDED", value: `${s.quality["COMPLETE"]} / ${s.quality["PARTIAL"]} / ${s.quality["NOT_RECORDED"]}` },
    { check: `Trade dengan signal lag >${SIGNAL_LAG_FLAG_MIN} menit (flag saja)`, value: s.lag_flags },
    { check: "Rentang (WIB)", value: `${s.first_trade_wib} → ${s.last_trade_wib}` },
    ...DATA_QUALITY_RULES.map((r) => ({ check: "Aturan kualitas", value: r })),
    { check: "Pembulatan", value: "Agregasi presisi penuh; pembulatan 2 desimal hanya saat tampil — selisih sen antar sheet bukan selisih data." },
    ...inp.notes.map((n) => ({ check: "Catatan", value: n })),
  ], "");

  add("Entry_Hour_Analysis", timeAnalysis(t, "entry"), "Tidak ada trade");
  add("Exit_Hour_Analysis", timeAnalysis(closed, "exit"), "Tidak ada trade closed");
  add("Lifecycle_Events", t.flatMap((x) => (Array.isArray(x.payload["lifecycle"]) ? (x.payload["lifecycle"] as Lc[]) : []).map((e) => ({ event_id: e.id ?? NR, trade_id: x.trade_id, source: x.source, symbol: x.symbol, mode: x.strategy, type: e.type ?? NR, at_wib: wib(num(e.at)), price: num(e.price) ?? "", pnl_usd: num(e.pnl_usd) ?? "", peak_pnl_usd: num(e.peak_pnl_usd) ?? "", trail_floor_usd: num(e.trail_floor_usd) ?? "", reason: e.reason ?? "", version: e.v ?? NR }))), "Belum ada lifecycle tercatat (lab-lifecycle-v1 hanya untuk kejadian baru; histori tidak di-backfill)");
  add("Arena_Events", (inp.arena ?? []).map((e) => ({ at: e.at, source: e.source, symbol: e.symbol ?? "", type: e.type, stage: e.stage ?? "", signal_id: e.signal_id ?? "", direction: e.direction ?? "", reason: e.reason || NR, result: e.result ?? "", block_reason: e.block_reason ?? "" })), "Tidak ada event ARENA engine");

  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return { bytes: new Uint8Array(bytes), summary: s };
}

export function telegramSummary(s: ReportSummary, fileOk: boolean): string {
  const f = (n: number) => { const v = r2(n); return v >= 0 ? `+$${v.toFixed(2)}` : `−$${Math.abs(v).toFixed(2)}`; };
  const T = s.total;
  const modeOk = s.mode_trade_sum === T.trades;
  const L = [
    `<b>📊 Lab Report · ${s.cutoff_wib} WIB</b>`, `Sumber: ${s.sources.join(", ") || NA}${s.sources.every((x) => x === "BROWSER_PAPER") ? " (simulasi, bukan order broker)" : ""}`, `Rentang: ${s.first_trade_wib} → ${s.last_trade_wib}`,
    `Trade unik ${s.unique_trades} = ${T.trades} CLOSED + ${s.open} OPEN`,
    `CLOSED: ${T.wins}W/${T.losses}L${T.flat ? `/${T.flat} flat` : ""} · WR ${T.win_rate == null ? "-" : r2(T.win_rate).toFixed(2)}%`,
    `Realized: ${f(T.net)}`, `Floating (OPEN): ${s.floating == null ? NA : f(s.floating)}`, `MaxDD realized: ${f(s.max_dd)}`,
    `P&L positif/negatif: ${f(T.positive_net_pnl)} / ${f(T.negative_net_pnl)} (bukan gross broker)`, "",
    ...Object.entries(s.bySymbol).map(([k, a]) => `${k}: ${a.trades} tr · WR ${a.win_rate == null ? "-" : r2(a.win_rate).toFixed(2)}% · ${f(a.net)}`), "",
    `<b>Mode (${s.byMode.length})</b>`, ...s.byMode.map(([k, a]) => `${k}: ${a.trades} · ${f(a.net)}`),
    `Σ mode: ${s.mode_trade_sum} trade ${modeOk ? "= CLOSED ✓" : `≠ CLOSED ${T.trades} ⚠️`}`, "",
    `Jam exit terbaik: ${s.bestHour}`, `Jam exit terburuk: ${s.worstHour}`,
    `Kualitas: COMPLETE ${s.quality["COMPLETE"]} · PARTIAL ${s.quality["PARTIAL"]} · NOT_RECORDED ${s.quality["NOT_RECORDED"]}`,
    `Daily guard/peak historis: ${NR} kecuali event baru (lab-eval-v1/lifecycle-v1)`, `Data: ${s.raw_rows} baris → ${s.unique_trades} unik · angka dibulatkan saat tampil`,
    `Excel: ${fileOk ? "terlampir" : "GAGAL dibuat"}`,
  ];
  return L.join("\n");
}
