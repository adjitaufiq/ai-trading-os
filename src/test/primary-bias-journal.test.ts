import { describe, expect, it } from "vitest";
import { updatePosition } from "@/engine/execution/positionManager";
import { candle, openTrade, T } from "@/engine/execution/tests/helpers";
import { fromPaperTrade, TradeJournal } from "@/engine/journal/tradeJournal";
import { jt } from "@/engine/journal/tests/helpers";

describe("PrimaryBias → M2 journal fields (optional, append-only)", () => {
  const closed = () => {
    const u = updatePosition(openTrade(), candle({ timestamp: T + 300, high: 2010, low: 1999 }), T + 600);
    if (!u.ok || u.trade.state !== "CLOSED") throw new Error("not closed");
    return u.trade;
  };
  it("carries primaryBias / primaryBiasAsOf / primaryBiasSource when supplied", () => {
    const row = fromPaperTrade(closed(), { h1Phase: "PULLBACK", locationTier: "T1", rr: 1.6, primaryBias: { bias: "BUY", asOf: 123, source: "TECHNICAL_H4_CLOSED" } });
    expect(row).toMatchObject({ primaryBias: "BUY", primaryBiasAsOf: 123, primaryBiasSource: "TECHNICAL_H4_CLOSED" });
  });
  it("legacy rows without the fields stay valid", () => {
    const row = fromPaperTrade(closed(), { h1Phase: "PULLBACK", locationTier: "T1", rr: 1.6 })!;
    expect("primaryBias" in row).toBe(false);
    expect(new TradeJournal().saveTrade(jt()).ok).toBe(true);
  });
});
