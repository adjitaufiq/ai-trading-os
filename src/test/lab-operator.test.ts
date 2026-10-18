import { describe, expect, it } from "vitest";
import { capEntries, closeManual, DEFAULT_OPERATOR, gateState, parseOperator, todayRealized, wibDayStart } from "@/core/lab/operatorControl";
import { emptyLab, openSignals } from "@/core/lab/labLedger";
import type { LabState, LabTrade } from "@/core/lab/labLedger";

const now = Date.UTC(2026, 9, 18, 12, 0);
const closed = (pnl: number, at: number) => ({ id: `t${at}${pnl}`, status: "CLOSED", pnl_usd: pnl, closed_at: at } as unknown as LabTrade);
const st = (...t: LabTrade[]): LabState => ({ ...emptyLab(), trades: t });

describe("lab operator", () => {
  it("defaults target $50 and max loss $30", () => { expect(DEFAULT_OPERATOR).toMatchObject({ targetUsd: 50, maxLossUsd: 30, paused: false }); });
  it("counts only trades closed since WIB midnight", () => {
    expect(todayRealized(st(closed(10, now), closed(99, wibDayStart(now) - 1)), now)).toBe(10);
  });
  it("stops at +$50 target", () => { expect(gateState(st(closed(50, now)), DEFAULT_OPERATOR, now)).toBe("TARGET_HIT"); });
  it("stops at -$30 loss", () => { expect(gateState(st(closed(-30, now)), DEFAULT_OPERATOR, now)).toBe("MAX_LOSS_HIT"); });
  it("pause blocks", () => { expect(gateState(st(), { ...DEFAULT_OPERATOR, paused: true }, now)).toBe("PAUSED"); });
  it("manual close uses bid for BUY", () => {
    const s = openSignals(emptyLab(), "BTCUSD", [{ strategy: "FAST_BREAKOUT", side: "BUY", bar_time: 1, sl_distance: 100, why: "x" } as never], { bid: 100, ask: 101 }, now);
    const c = closeManual(s, "ALL", { BTCUSD: { bid: 111, ask: 112 } }, now);
    expect(c.trades[0]).toMatchObject({ status: "CLOSED", exit_reason: "MANUAL", exit_price: 111 });
    expect(c.trades[0]!.pnl_usd).toBeCloseTo(0.5);
  });
  it("defaults 1 entry per mode per market and 10 total", () => { expect(DEFAULT_OPERATOR.maxOpenTotal).toBe(10); expect(DEFAULT_OPERATOR.marketQuota.FAST_BREAKOUT).toEqual({ XAUUSD: 1, BTCUSD: 1 }); });
  const open = (strategy: string, symbol = "XAUUSD") => ({ id: strategy + Math.random(), status: "OPEN", strategy, symbol } as unknown as LabTrade);
  it("blocks a second entry of a mode on the same market", () => {
    const out = capEntries([{ strategy: "FAST_BREAKOUT" }, { strategy: "BREAKOUT_RETEST" }] as never[], st(open("FAST_BREAKOUT")), DEFAULT_OPERATOR, "XAUUSD");
    expect(out.map((s: { strategy: string }) => s.strategy)).toEqual(["BREAKOUT_RETEST"]);
  });
  it("allows the same mode on the other market at the same time", () => {
    expect(capEntries([{ strategy: "FAST_BREAKOUT" }] as never[], st(open("FAST_BREAKOUT", "XAUUSD")), DEFAULT_OPERATOR, "BTCUSD")).toHaveLength(1);
  });
  it("stops all new entries at the global limit of 10", () => {
    const ten = Array.from({ length: 10 }, (_, i) => open(`M${i}`, i % 2 ? "BTCUSD" : "XAUUSD"));
    expect(capEntries([{ strategy: "TREND_PULLBACK" }] as never[], st(...ten), DEFAULT_OPERATOR, "BTCUSD")).toEqual([]);
  });
  it("market quota 0 disables a mode on that market, quota 2 allows a second entry", () => {
    const op = parseOperator({ maxOpenTotal: 10, marketQuota: { FAST_BREAKOUT: { XAUUSD: 2, BTCUSD: 0 } } });
    expect(capEntries([{ strategy: "FAST_BREAKOUT" }] as never[], st(open("FAST_BREAKOUT")), op, "XAUUSD")).toHaveLength(1);
    expect(capEntries([{ strategy: "FAST_BREAKOUT" }] as never[], st(), op, "BTCUSD")).toEqual([]);
  });
  it("old saved settings migrate to 10 total and 1 per market", () => {
    const op = parseOperator({ maxOpenTotal: 3, maxOpenPerMode: { FAST_BREAKOUT: 1 } });
    expect(op.maxOpenTotal).toBe(10); expect(op.marketQuota.FAST_BREAKOUT).toEqual({ XAUUSD: 1, BTCUSD: 1 });
  });
});
