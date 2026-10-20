import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { aggregate, buildWorkbook, dataQuality, dedupTrades, maxDrawdown, openedClosedByDate, summarize, telegramSummary, type ReportInput, type TradeRow } from "./labReport";
import { appendEval, withLifecycle, type LabEvalEvent, type LabState, type LabTrade } from "@/core/lab/labLedger";

const H = 3600_000;
const t = (id: string, pnl: number, rev = 1, status = "CLOSED", closed = 2000, extra: Partial<TradeRow> = {}): TradeRow => ({ session_id: "s", trade_id: id, strategy: "M", symbol: "XAUUSD", side: "BUY", status, pnl_usd: pnl, opened_at_ms: 1000, closed_at_ms: status === "CLOSED" ? closed : null, revision: rev, payload: {}, source: "BROWSER_PAPER", ...extra });
const inp = (trades: TradeRow[], o: Partial<ReportInput> = {}): ReportInput => ({ trades, rawTradeRows: trades.length, sessions: [], signals: [], risk: [], arena: [], demoTradeRows: 0, notes: [], cutoffMs: 10 * H, ...o });

describe("lab report v2", () => {
  it("dedup keeps highest revision so OPEN→CLOSED is one trade", () => {
    const d = dedupTrades([t("a", 0, 1, "OPEN"), t("a", 5, 2), t("b", -10)]);
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.trade_id === "a")!.status).toBe("CLOSED");
  });
  it("reconciles unique = CLOSED + OPEN and net over closed only", () => {
    const s = summarize(inp([t("a", 5), t("b", -10), t("c", -3, 1, "OPEN", 0, { payload: { pnl_usd: -3 } })]));
    expect(s.unique_trades).toBe(3);
    expect(s.total.trades).toBe(2);
    expect(s.open).toBe(1);
    expect(s.total.net).toBe(-5);
    expect(s.floating).toBe(-3);
  });
  it("keeps full precision (no intermediate rounding drift)", () => {
    const rows = Array.from({ length: 3 }, (_, i) => t(`x${i}`, 0.005, 1, "CLOSED", 2000 + i * H));
    expect(aggregate(rows).net).toBeCloseTo(0.015, 10);
  });
  it("max drawdown follows close order", () => {
    expect(maxDrawdown([t("a", 10, 1, "CLOSED", 1), t("b", -15, 1, "CLOSED", 2), t("c", 2, 1, "CLOSED", 3)])).toBe(-15);
  });
  it("counts a cross-midnight trade once opened and once closed on different WIB dates", () => {
    const open = Date.UTC(2026, 9, 19, 16, 30); // 23:30 WIB 19 Oct
    const r = openedClosedByDate([t("a", 1, 1, "CLOSED", open + H, { opened_at_ms: open })]);
    expect(r).toEqual([{ date_wib: "2026-10-19", opened_count: 1, closed_count: 0 }, { date_wib: "2026-10-20", opened_count: 0, closed_count: 1 }]);
  });
  it("data quality: missing entry ⇒ NOT_RECORDED, missing lifecycle ⇒ PARTIAL, all required ⇒ COMPLETE", () => {
    expect(dataQuality(t("a", 1)).status).toBe("NOT_RECORDED");
    const base = { entry: 1, exit_price: 2, lot: 0.02, sl: 0.5, tp: 2, signal_bar_time: 900, rr_mode: "COPET", exit_reason: "TP", peak_pnl_usd: 1 };
    expect(dataQuality(t("b", 1, 1, "CLOSED", 2000, { payload: base })).status).toBe("PARTIAL");
    const full = { ...base, lifecycle: [{ type: "OPENED" }, { type: "CLOSED" }] };
    expect(dataQuality(t("c", 1, 1, "CLOSED", 2000, { payload: full }))).toEqual({ status: "COMPLETE", missing: [] });
  });
  it("Telegram lists every mode and Σ mode equals CLOSED", () => {
    const modes = Array.from({ length: 13 }, (_, i) => t(`m${i}`, i === 12 ? -48.87 : 1, 1, "CLOSED", 2000, { strategy: `MODE_${i}` }));
    const s = summarize(inp(modes));
    const msg = telegramSummary(s, true);
    expect(s.byMode).toHaveLength(13);
    expect(msg).toContain("MODE_12: 1 · −$48.87");
    expect(msg).toContain("Σ mode: 13 trade = CLOSED ✓");
  });
  it("ARENA events go to Arena_Events, not Signal_Log", () => {
    const arena = [{ source: "ARENA_ENGINE:x", at: "2026", symbol: "XAUUSD", type: "READY", stage: null, signal_id: "z", direction: null, reason: "r", result: null, block_reason: null }];
    const { bytes } = buildWorkbook(inp([t("a", 5)], { arena }));
    const wb = XLSX.read(bytes, { type: "array" });
    expect(XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets["Signal_Log"]!)[0]!["source"]).toBeUndefined();
    expect(XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets["Arena_Events"]!)[0]!["source"]).toBe("ARENA_ENGINE:x");
  });
  it("flags signal lag >10 min and long OPEN without changing the trade", () => {
    const tr = t("a", -7, 1, "OPEN", 0, { opened_at_ms: 2 * H, payload: { signal_bar_time: 2 * H - 27 * 60_000 } });
    const s = summarize(inp([tr]));
    expect(s.lag_flags).toBe(1);
    expect(s.long_open).toBe(1);
    const { bytes } = buildWorkbook(inp([tr]));
    const row = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.read(bytes, { type: "array" }).Sheets["Position_Snapshots"]!)[0]!;
    expect(row["age_hours_at_cutoff"]).toBe(8);
    expect(row["review_flag"]).toBe("OPEN_GT_4H_REVIEW");
  });
  it("workbook keeps the 10 original sheets plus 4 source-separated sheets", () => {
    const { bytes } = buildWorkbook(inp([t("a", 5), t("b", -10)], { rawTradeRows: 3 }));
    const wb = XLSX.read(bytes, { type: "array" });
    expect(wb.SheetNames).toEqual(["Dashboard", "Trades_Raw", "Sessions", "Hourly_Snapshots", "Position_Snapshots", "Signal_Log", "Risk_Events", "Mode_Performance", "Hourly_Performance", "Data_Quality", "Entry_Hour_Analysis", "Exit_Hour_Analysis", "Lifecycle_Events", "Arena_Events"]);
    expect(XLSX.utils.sheet_to_json(wb.Sheets["Trades_Raw"]!)).toHaveLength(2);
  });
});

describe("paper instrumentation (append-only, observation only)", () => {
  const tr = (o: Partial<LabTrade> = {}): LabTrade => ({ id: "lab-1", strategy: "EMA_CROSS" as LabTrade["strategy"], symbol: "XAUUSD", side: "BUY", why: "w", opened_at: 100, signal_bar_time: 0, entry: 10, sl: 9, tp: 11, lot: 0.02, status: "OPEN", mark: 10, pnl_usd: 0, closed_at: null, exit_price: null, exit_reason: null, version: "v", rr_mode: "COPET", peak_pnl_usd: 0, trail_floor_usd: null, ...o });
  const st = (trades: LabTrade[]): LabState => ({ trades, seen: {}, started_at: 0 });
  it("records OPENED, TRAIL, CLOSED once each and never touches prices/P&L", () => {
    const a = withLifecycle(st([]), st([tr()]), 100);
    const b = withLifecycle(a, st([{ ...a.trades[0]!, peak_pnl_usd: 4, trail_floor_usd: 2, pnl_usd: 4 }]), 200);
    const b2 = withLifecycle(b, st([{ ...b.trades[0]!, pnl_usd: 3.5 }]), 210); // same floor ⇒ no new event
    const c = withLifecycle(b2, st([{ ...b2.trades[0]!, status: "CLOSED", closed_at: 300, exit_price: 10.1, exit_reason: "TRAIL", pnl_usd: 2 }]), 300);
    const again = withLifecycle(b2, st([{ ...b2.trades[0]!, status: "CLOSED", closed_at: 300, exit_price: 10.1, exit_reason: "TRAIL", pnl_usd: 2 }]), 300);
    expect(c.trades[0]!.lifecycle!.map((e) => e.type)).toEqual(["OPENED", "TRAIL_FLOOR_SET", "CLOSED"]);
    expect(again.trades[0]!.lifecycle!.map((e) => e.id)).toEqual(c.trades[0]!.lifecycle!.map((e) => e.id));
    expect(c.trades[0]!.pnl_usd).toBe(2);
    expect(c.trades[0]!.exit_price).toBe(10.1);
  });
  it("does not invent an OPENED event for trades opened before instrumentation", () => {
    const old = tr();
    const n = withLifecycle(st([old]), st([{ ...old, pnl_usd: 1, mark: 10.5 }]), 200);
    expect(n.trades[0]!.lifecycle).toBeUndefined();
  });
  it("evaluation log is append-only by stable id", () => {
    const e: LabEvalEvent = { id: "eval:XAUUSD:1", v: "lab-eval-v1", symbol: "XAUUSD", bar_time: 1, at: 2, gate: "RUNNING", candidates: [], safety_block: null, spv_block: null, after_spv: [], capped: [], accepted: [] };
    const l1 = appendEval([], e);
    const l2 = appendEval(l1, { ...e, gate: "PAUSED" });
    expect(l2).toHaveLength(1);
    expect(l2[0]!.gate).toBe("RUNNING");
  });
});
