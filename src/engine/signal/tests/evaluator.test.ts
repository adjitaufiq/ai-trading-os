import { describe, expect, it } from "vitest";
import { evaluateSetup } from "../signalEvaluator";
import { bias, ema, input, loc, reaction } from "./helpers";

const cand = (p = {}) => {
  const e = evaluateSetup(input(p));
  if (e.kind !== "CANDIDATE") throw new Error(e.reason);
  return e;
};

describe("M2 signal evaluator", () => {
  it("support BUY setup → READY with full trace", () => {
    const e = cand();
    expect(e).toMatchObject({ direction: "BUY", state: "READY" });
    expect(e.trace.checks.map((c) => [c.name, c.result])).toEqual(
      expect.arrayContaining([["H4 Bias", "PASS"], ["M15 Location", "PASS"], ["EMA Context", "PASS"], ["M5 Reaction", "PASS"]]),
    );
  });
  it("resistance SELL setup → READY", () => {
    expect(cand({ bias: bias("BEARISH"), priceContext: loc("AT_RESISTANCE"), emaContext: ema(["EMA21_REJECT_DOWN"]), reaction: reaction("BEARISH") }))
      .toMatchObject({ direction: "SELL", state: "READY" });
  });
  it("mid-range blocked", () => {
    expect(evaluateSetup(input({ priceContext: loc("MID_RANGE", "SUPPORT", 20) }))).toMatchObject({ kind: "NO_SETUP", reason: "MID_RANGE" });
  });
  it("radar when approaching level", () => {
    expect(cand({ priceContext: loc("MID_RANGE", "SUPPORT", 3) })).toMatchObject({ direction: "BUY", state: "RADAR_AREA" });
  });
  it("breakout waiting ⇒ wrong location", () => {
    expect(evaluateSetup(input({ priceContext: loc("BREAKOUT_WAITING") }))).toMatchObject({ kind: "NO_SETUP", reason: "WRONG_LOCATION" });
  });
  it("missing trigger ⇒ WAITING_REACTION", () => {
    expect(cand({ reaction: null })).toMatchObject({ state: "WAITING_REACTION" });
  });
  it("weak reaction ⇒ WAITING_REACTION", () => {
    expect(cand({ reaction: reaction("BULLISH", "WEAK") }).state).toBe("WAITING_REACTION");
  });
  it("wrong-direction reaction at support ⇒ WAITING_REACTION", () => {
    expect(cand({ reaction: reaction("BEARISH") }).state).toBe("WAITING_REACTION");
  });
  it("valid M5 bullish reaction confirmed", () => {
    expect(cand({ reaction: reaction("BULLISH", "MODERATE") }).trace.checks.find((c) => c.name === "M5 Reaction")?.result).toBe("PASS");
  });
  it("valid M5 bearish reaction confirmed", () => {
    const e = cand({ bias: bias("BEARISH"), priceContext: loc("AT_RESISTANCE"), emaContext: ema([]), reaction: reaction("BEARISH", "MODERATE") });
    expect(e.state).toBe("READY");
  });
  it("counter bias ⇒ REACTION_CONFIRMED (not READY)", () => {
    expect(cand({ bias: bias("BEARISH") }).state).toBe("REACTION_CONFIRMED");
  });
  it("EMA failed ⇒ REACTION_CONFIRMED", () => {
    expect(cand({ emaContext: ema(["EMA21_REJECT_DOWN"]) }).state).toBe("REACTION_CONFIRMED");
  });
  it("stale / not closed / structure invalid ⇒ NO_SETUP", () => {
    expect(evaluateSetup(input({ dataStale: true }))).toMatchObject({ reason: "DATA_STALE" });
    expect(evaluateSetup(input({ m5CandleClosed: false }))).toMatchObject({ reason: "CANDLE_NOT_CLOSED" });
    expect(evaluateSetup(input({ m15StructureValid: false }))).toMatchObject({ reason: "STRUCTURE_INVALID" });
  });
});
