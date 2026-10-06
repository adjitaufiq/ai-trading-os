import { describe, expect, it } from "vitest";
import { evaluateSetup } from "../signalEvaluator";
import { cancelSetup, createSetup, updateSetup, type UpdateInput } from "../signalLifecycle";
import type { SignalSetup } from "../types";
import { T0, bias, ema, input, loc, m5, reaction } from "./helpers";

function born(p = {}): SignalSetup {
  const i = input(p);
  const r = createSetup(evaluateSetup(i), i, i.reaction!, m5(0, 2651), 2651);
  if (!r) throw new Error("not created");
  return r.setup;
}
const upd = (s: SignalSetup, p: Partial<UpdateInput> = {}) =>
  updateSetup(s, { m5: m5(1, 2652), price: 2652, m15Atr: 4, m15StructureShift: "NONE", emaContext: ema([]), now: T0 + 600, ...p });

describe("M2 signal lifecycle", () => {
  it("radar evaluation does not create a setup", () => {
    const i = input({ priceContext: loc("MID_RANGE", "SUPPORT", 3) });
    expect(evaluateSetup(i)).toMatchObject({ state: "RADAR_AREA" });
    expect(createSetup(evaluateSetup(i), i, reaction("BULLISH"), m5(0, 2651), 2651)).toBeNull();
  });
  it("waiting reaction does not create a setup", () => {
    const i = input({ reaction: null });
    expect(createSetup(evaluateSetup(i), i, reaction("BULLISH"), m5(0, 2651), 2651)).toBeNull();
  });
  it("reaction confirmed creates setup", () => {
    expect(born({ bias: bias("BEARISH") })).toMatchObject({ state: "REACTION_CONFIRMED", direction: "BUY" });
  });
  it("READY setup with spec fields", () => {
    expect(born()).toMatchObject({
      id: `XAUUSD_BUY_${T0}`, state: "READY", location: "AT_SUPPORT", keyLevel: 2650.5,
      triggerPattern: "BULLISH_REJECTION_WICK", reactionQuality: "STRONG",
      biasContext: "H4_BULLISH_H1_PULLBACK", createdAt: T0, expiryTimestamp: T0 + 900, snapshotPrice: 2651,
    });
  });
  it("REACTION_CONFIRMED → READY on later passing evaluation", () => {
    const s = born({ bias: bias("BEARISH") });
    expect(upd(s, { evaluation: evaluateSetup(input()) }).setup.state).toBe("READY");
  });
  it("running candle never creates a setup", () => {
    const i = input();
    expect(createSetup(evaluateSetup(i), i, i.reaction!, m5(0, 2651, false), 2651)).toBeNull();
  });
  it("invalidated: support broken by closed M5", () => {
    expect(upd(born(), { m5: m5(1, 2649) }).setup).toMatchObject({ state: "INVALIDATED", invalidationReason: "LOCATION_BROKEN" });
  });
  it("invalidated: bearish MSS", () => {
    expect(upd(born(), { m15StructureShift: "BEARISH_MSS" }).setup.invalidationReason).toBe("STRUCTURE_SHIFT");
  });
  it("invalidated: EMA21 support failed", () => {
    expect(upd(born(), { emaContext: ema(["EMA21_REJECT_DOWN"]) }).setup.invalidationReason).toBe("EMA_CONTEXT_FAILED");
  });
  it("SELL invalidated by close above resistance", () => {
    const s = born({ bias: bias("BEARISH"), priceContext: loc("AT_RESISTANCE"), emaContext: ema([]), reaction: reaction("BEARISH") });
    expect(upd(s, { m5: m5(1, 2651), price: 2650 }).setup.invalidationReason).toBe("LOCATION_BROKEN");
  });
  it("anti-chase: within 0.5 ATR accepted", () => {
    expect(upd(born(), { price: 2652.9 }).setup.state).toBe("READY");
  });
  it("anti-chase: beyond 0.5 ATR expired", () => {
    expect(upd(born(), { price: 2653.5 }).setup).toMatchObject({ state: "EXPIRED", invalidationReason: "TTL_EXPIRED", expiredBy: "PRICE_CHASED" });
  });
  it("TTL: 3 M5 candles valid", () => {
    let s = born();
    for (const i of [1, 2]) s = upd(s, { m5: m5(i, 2652) }).setup;
    expect(s.state).toBe("READY");
  });
  it("TTL: 4th candle expired", () => {
    expect(upd(born(), { m5: m5(3, 2652) }).setup).toMatchObject({ state: "EXPIRED", expiredBy: "TTL" });
  });
  it("terminal states never change; manual cancel", () => {
    const x = upd(born(), { m5: m5(3, 2652) }).setup;
    expect(upd(x, { m5: m5(4, 2649) }).setup).toBe(x);
    expect(cancelSetup(born(), 1).invalidationReason).toBe("MANUAL_CANCEL");
  });
  it("trace emitted on state change", () => {
    const r = upd(born(), { m5: m5(1, 2649) });
    expect(r.trace).toMatchObject({ state: "INVALIDATED" });
    expect(r.trace.checks[0]).toMatchObject({ name: "Location Held", result: "FAIL" });
  });
  it("safety: no SL / TP / lot fields", () => {
    const s = born() as unknown as Record<string, unknown>;
    for (const k of ["sl", "stopLoss", "tp", "tp1", "tp2", "takeProfit", "lot", "lotSize", "volume", "entry"]) expect(s[k]).toBeUndefined();
  });
});
