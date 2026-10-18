import { describe, expect, it } from "vitest";
import { closeManual, DEFAULT_OPERATOR, gateState, todayRealized, wibDayStart } from "@/core/lab/operatorControl";
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
});
