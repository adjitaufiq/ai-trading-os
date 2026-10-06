import { describe, expect, it } from "vitest";
import { updatePosition } from "../positionManager";
import { closePaperTrade, openPaperTrade } from "../tradeLifecycle";
import { candle, openTrade, plan, T } from "./helpers";

describe("lifecycle", () => {
  it("PENDING → OPEN → TP_HIT with result", () => {
    const t = openTrade();
    expect(t.state).toBe("OPEN");
    const r = updatePosition(t, candle({ high: 2008.5 }), T + 300);
    expect(r.ok && r.trade.state).toBe("CLOSED");
    expect(r.trade.result).toMatchObject({ closeReason: "TP_HIT", exit: 2008, durationSeconds: 300 });
    expect(r.trade.result!.profitLossUSD).toBeCloseTo(152); // (2008−2000.3)/0.01×1×0.2
  });
  it("OPEN → SL_HIT", () => {
    const r = updatePosition(openTrade(), candle({ low: 1994 }), T + 300);
    expect(r.trade.result).toMatchObject({ closeReason: "SL_HIT", exit: 1995 });
    expect(r.trade.result!.profitLossUSD).toBeLessThan(0);
  });
  it("same-candle conflict ⇒ SL first", () => {
    const r = updatePosition(openTrade(), candle({ low: 1994, high: 2010 }), T + 300);
    expect(r.trade.result!.closeReason).toBe("SL_HIT");
  });
  it("SELL exits mirror", () => {
    const s = openTrade({ plan: plan({ direction: "SELL", entry: 2000, sl: 2005, tp: 1992 }) });
    expect(updatePosition(s, candle({ low: 1991 }), T + 300).trade.result!.closeReason).toBe("TP_HIT");
    expect(updatePosition(s, candle({ high: 2006 }), T + 300).trade.result!.closeReason).toBe("SL_HIT");
  });
  it("running candle refused, no hit keeps OPEN", () => {
    const t = openTrade();
    expect(updatePosition(t, candle({ isClosed: false, high: 2010 }), T + 300)).toMatchObject({ ok: false, error: "CANDLE_NOT_CLOSED" });
    expect(updatePosition(t, candle({}), T + 300).trade.state).toBe("OPEN");
  });
  it("invalid transitions rejected", () => {
    const t = openTrade();
    expect(openPaperTrade(t, T)).toMatchObject({ ok: false, error: "INVALID_TRANSITION" });
    const c = closePaperTrade(t, "MANUAL_CLOSE", 2001, T + 60);
    expect(c.ok).toBe(true);
    expect(closePaperTrade(c.trade, "MANUAL_CLOSE", 2001, T + 60)).toMatchObject({ ok: false, error: "INVALID_TRANSITION" });
    expect(updatePosition(c.trade, candle({ high: 2010 }), T + 600)).toMatchObject({ ok: false, error: "INVALID_TRANSITION" });
  });
});
