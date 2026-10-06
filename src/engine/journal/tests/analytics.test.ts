import { describe, expect, it } from "vitest";
import { analyzeByBias, analyzeBySetup, bestAndWorst } from "../setupAnalytics";
import { jt } from "./helpers";

const data = () => [
  jt({ profitLossUSD: 50 }), jt({ profitLossUSD: 50 }), jt({ profitLossUSD: -50 }),
  jt({ profitLossUSD: -50, ctx: { priceLocation: "MID_RANGE", triggerPattern: "BULLISH_ENGULFING", reactionQuality: "WEAK", h1Phase: "CONTINUATION" } }),
  jt({ profitLossUSD: 50, ctx: { priceLocation: "MID_RANGE", reactionQuality: "WEAK", h1Phase: "CONTINUATION" } }),
];

describe("setup analytics", () => {
  it("groups by location", () => {
    const loc = analyzeBySetup(data()).byLocation;
    expect(loc.find((g) => g.key === "AT_SUPPORT")).toMatchObject({ trades: 3, wins: 2, totalR: 1 });
    expect(loc.find((g) => g.key === "MID_RANGE")).toMatchObject({ trades: 2, winRate: 0.5 });
  });
  it("groups by trigger", () => {
    expect(analyzeBySetup(data()).byTrigger.find((g) => g.key === "BULLISH_REJECTION_WICK")).toMatchObject({ trades: 4, wins: 3 });
  });
  it("groups by reaction quality", () => {
    const q = analyzeBySetup(data()).byReactionQuality;
    expect(q.find((g) => g.key === "STRONG")!.winRate).toBeCloseTo(0.6667, 3);
    expect(q.find((g) => g.key === "WEAK")!.winRate).toBe(0.5);
  });
  it("groups by H4 bias + H1 phase", () => {
    expect(analyzeByBias(data()).find((g) => g.key === "H4_BULLISH | PULLBACK")).toMatchObject({ trades: 3, totalR: 1 });
  });
  it("best / worst is descriptive and respects min sample", () => {
    const all = analyzeBySetup(data()).byLocationTrigger;
    expect(bestAndWorst(all).best!.key).toBe("MID_RANGE + BULLISH_REJECTION_WICK"); // 1 trade, 100%
    const { best } = bestAndWorst(all, 2);
    const { worst } = bestAndWorst(all);
    expect(best!.key).toBe("AT_SUPPORT + BULLISH_REJECTION_WICK");
    expect(worst!.key).toBe("MID_RANGE + BULLISH_ENGULFING");
    expect(bestAndWorst(analyzeBySetup(data()).byLocation, 10).best).toBeNull();
  });
  it("analytics never mutate input", () => {
    const d = data(); const snap = JSON.stringify(d);
    analyzeBySetup(d); analyzeByBias(d);
    expect(JSON.stringify(d)).toBe(snap);
  });
});
