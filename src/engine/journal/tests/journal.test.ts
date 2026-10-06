import { describe, expect, it } from "vitest";
import { exportJournal } from "../exportService";
import { fromPaperTrade, TradeJournal } from "../tradeJournal";
import { updatePosition } from "../../execution/positionManager";
import { candle, openTrade, T } from "../../execution/tests/helpers";
import { jt } from "./helpers";

describe("journal storage", () => {
  it("saves trade", () => {
    const j = new TradeJournal();
    expect(j.saveTrade(jt()).ok).toBe(true);
    expect(j.size).toBe(1);
  });
  it("rejects duplicate id, original kept", () => {
    const j = new TradeJournal(); const a = jt({ profitLossUSD: -10 });
    j.saveTrade(a);
    expect(j.saveTrade({ ...a, profitLossUSD: 999 })).toEqual({ ok: false, error: "DUPLICATE_TRADE_ID" });
    expect(j.getAll()[0]!.profitLossUSD).toBe(-10);
  });
  it("append only, ordered, no mutation API", () => {
    const j = new TradeJournal(); const a = jt(), b = jt();
    j.saveTrade(a); j.saveTrade(b);
    expect(j.getAll().map((t) => t.tradeId)).toEqual([a.tradeId, b.tradeId]);
    expect("updateTrade" in j || "deleteTrade" in j).toBe(false);
    expect(() => (j.getAll() as unknown[]).push(1)).toThrow();
  });
  it("cannot alter snapshot or historical result", () => {
    const j = new TradeJournal(); const src = jt();
    const r = j.saveTrade(src); if (!r.ok) throw new Error();
    src.profitLossUSD = -500; src.context.priceLocation = "X"; // caller object changes do not leak
    const s = j.getAll()[0]!;
    expect(s.profitLossUSD).toBe(20); expect(s.context.priceLocation).toBe("AT_SUPPORT");
    expect(() => { (s as { result: string }).result = "LOSS"; }).toThrow();
    expect(() => { (s.context as { rr: number }).rr = 9; }).toThrow();
    expect(() => { (s.decisionTrace as string[]).push("x"); }).toThrow();
  });
  it("query filters", () => {
    const j = new TradeJournal();
    j.saveTrade(jt({ profitLossUSD: -10 }));
    j.saveTrade(jt({ profitLossUSD: 20 }));
    j.saveTrade(jt({ profitLossUSD: -10, ctx: { priceLocation: "MID_RANGE" } }));
    expect(j.queryTrades({ symbol: "XAUUSD", result: "LOSS", location: "AT_SUPPORT", trigger: "BULLISH_REJECTION_WICK" })).toHaveLength(1);
    expect(j.queryTrades({ closeReason: "TP_HIT" })).toHaveLength(1);
    expect(j.queryTrades({ dateRange: { from: 0, to: 1 } })).toHaveLength(0);
  });
  it("maps a closed M5 paper trade without recalculating", () => {
    const closed = updatePosition(openTrade(), candle({ high: 2009 }), T + 300).trade;
    const row = fromPaperTrade(closed, { h1Phase: "PULLBACK", locationTier: "TIER_1", rr: 1.6 })!;
    expect(row).toMatchObject({ entryPrice: 2000.3, exitPrice: 2008, stopLoss: 1995, lot: 0.2, result: "WIN", closeReason: "TP_HIT", profitLossUSD: 154 });
    expect(fromPaperTrade(openTrade(), { h1Phase: "", locationTier: "", rr: 0 })).toBeNull();
  });
  it("exports CSV and JSON", () => {
    const t = jt();
    const csv = exportJournal([t], "CSV").split("\n");
    expect(csv[0]).toBe("Date,Symbol,Direction,Location,Trigger,Entry,SL,TP,Result,PnL,Reason");
    expect(csv[1]).toContain("XAUUSD,BUY,AT_SUPPORT,BULLISH_REJECTION_WICK,2650,2645,2656,WIN,20,TP_HIT");
    expect(JSON.parse(exportJournal([t], "JSON"))[0].tradeId).toBe(t.tradeId);
  });
});
