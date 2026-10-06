import { describe, expect, it } from "vitest";
import { evaluateReaction, type ReactionInput } from "../reactionEvaluator";
import type { ReactionResult } from "../types";
import { c, ema, loc } from "./helpers";

const bullPrev = c(0, 2005, 2006, 1999, 2000);
const bullCur = c(1, 2000, 2010, 1997, 2009); // engulfing, range 13
const bearPrev = c(0, 2000, 2006, 1999, 2005);
const bearCur = c(1, 2005, 2008, 1994, 1996);

function run(i: Partial<ReactionInput>): ReactionResult {
  const r = evaluateReaction({ previous: bullPrev, current: bullCur, priceContext: loc("AT_SUPPORT"), emaContext: ema(["EMA21_RETEST"]), atr: 10, ...i });
  if (!r.ok) throw new Error(r.reason);
  return r.result;
}

describe("M1B.7 reaction evaluator", () => {
  it("strong bullish reaction at support with EMA21 retest", () => {
    const r = run({});
    expect(r).toMatchObject({ pattern: "BULLISH_ENGULFING", direction: "BULLISH", quality: "STRONG", isValid: true, locationConfirmed: true, emaContextConfirmed: true });
  });
  it("strong bearish reaction at resistance with EMA21 reject down", () => {
    const r = run({ previous: bearPrev, current: bearCur, priceContext: loc("AT_RESISTANCE"), emaContext: ema(["EMA21_REJECT_DOWN"]) });
    expect(r).toMatchObject({ direction: "BEARISH", quality: "STRONG", isValid: true });
  });
  it("weak reaction in mid-range ⇒ invalid", () => {
    const r = run({ priceContext: loc("MID_RANGE"), emaContext: ema(["NONE"]) });
    expect(r).toMatchObject({ pattern: "BULLISH_ENGULFING", quality: "WEAK", isValid: false, locationConfirmed: false });
  });
  it("EMA21 retest alone ⇒ MODERATE", () => {
    expect(run({ priceContext: loc("MID_RANGE") })).toMatchObject({ quality: "MODERATE", emaContextConfirmed: true, isValid: true });
  });
  it("EMA rejection confirmation (EMA21_REJECT_UP)", () => {
    expect(run({ emaContext: ema(["EMA21_REJECT_UP"]) }).emaContextConfirmed).toBe(true);
  });
  it("opposite-direction EMA action does not confirm", () => {
    expect(run({ emaContext: ema(["EMA21_REJECT_DOWN"]) }).emaContextConfirmed).toBe(false);
  });
  it("location + EMA but small range ⇒ MODERATE", () => {
    expect(run({ atr: 50 }).quality).toBe("MODERATE");
  });
  it("bullish pattern at resistance does not confirm location", () => {
    expect(run({ priceContext: loc("AT_RESISTANCE") }).locationConfirmed).toBe(false);
  });
  it("inside bar never valid", () => {
    const r = run({ previous: c(0, 2000, 2020, 1980, 2001), current: c(1, 2005, 2010, 1995, 2003) });
    expect(r).toMatchObject({ pattern: "INSIDE_BAR", direction: "NEUTRAL", quality: "WEAK", isValid: false });
  });
  it("no pattern ⇒ NONE", () => {
    const r = run({ previous: c(0, 2030, 2040, 2025, 2035), current: c(1, 2000, 2010, 1997, 2005) });
    expect(r).toMatchObject({ pattern: "NONE", quality: "NONE", isValid: false });
  });
  it("running candle rejected", () => {
    const r = evaluateReaction({ previous: bullPrev, current: { ...bullCur, isClosed: false }, priceContext: loc("AT_SUPPORT"), emaContext: ema([]), atr: 10 });
    expect(r).toEqual({ ok: false, reason: "RUNNING_CANDLE" });
  });
  it("non-M5 / non-consecutive / bad ATR rejected", () => {
    const base = { previous: bullPrev, current: bullCur, priceContext: loc("AT_SUPPORT"), emaContext: ema([]), atr: 10 };
    expect(evaluateReaction({ ...base, current: { ...bullCur, timeframe: "M15" } })).toEqual({ ok: false, reason: "INVALID_TIMEFRAME" });
    expect(evaluateReaction({ ...base, current: { ...bullCur, timestamp: bullCur.timestamp + 300 } })).toEqual({ ok: false, reason: "NON_CONSECUTIVE_CANDLES" });
    expect(evaluateReaction({ ...base, atr: 0 })).toEqual({ ok: false, reason: "INVALID_ATR" });
  });
  it("safety: no BUY/SELL, SL, TP, lot fields", () => {
    const r = run({}) as unknown as Record<string, unknown>;
    for (const k of ["side", "signal", "sl", "tp", "tp1", "tp2", "stopLoss", "takeProfit", "lot", "entry"]) expect(r[k]).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/"(BUY|SELL)"/);
  });
});
