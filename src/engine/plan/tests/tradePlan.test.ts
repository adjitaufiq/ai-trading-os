import { describe, expect, it } from "vitest";
import type { MarketStructure, SwingPoint } from "../../core/swing/types";
import type { SignalSetup } from "../../signal/types";
import { calculateStopLoss } from "../slCalculator";
import { calculateTakeProfit } from "../tpCalculator";
import { buildTradePlan, type PlanInput } from "../tradePlanEngine";

const NOW = 1_700_010_000;
const sw = (type: "HIGH" | "LOW", price: number, confirmedAt = NOW - 900, tf: SwingPoint["timeframe"] = "M15"): SwingPoint => ({
  id: `${type}${price}`, symbol: "XAUUSD", timeframe: tf, type, price, timestamp: confirmedAt - 2700, confirmedAt,
  strength: "NORMAL", leftBars: 2, rightBars: 2, rejectionWickRatio: 0,
});
const st = (p: Partial<MarketStructure> = {}): MarketStructure => ({
  symbol: "XAUUSD", timeframe: "M15", trend: "HH_HL", lastConfirmedHigh: sw("HIGH", 2662), lastConfirmedLow: sw("LOW", 2648),
  previousHigh: sw("HIGH", 2670), previousLow: sw("LOW", 2640), structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: NOW, ...p,
});
const setup = (p: Partial<SignalSetup> = {}): SignalSetup => ({
  id: "XAUUSD_BUY_1", symbol: "XAUUSD", direction: "BUY", state: "READY", createdAt: 1, updatedAt: 1,
  location: "AT_SUPPORT", keyLevel: 2650, triggerPattern: "BULLISH_ENGULFING", reactionQuality: "STRONG",
  biasContext: "H4_BULLISH_H1_PULLBACK", expiryTimestamp: 2, snapshotPrice: 2651, ...p,
});
const sell = (p: Partial<SignalSetup> = {}) => setup({ id: "XAUUSD_SELL_1", direction: "SELL", location: "AT_RESISTANCE", keyLevel: 2662, ...p });
const plan = (p: Partial<PlanInput> = {}) => buildTradePlan({ setup: setup(), entry: 2651, m15Structure: st(), atrM15: 4, now: NOW, ...p });

describe("M3 SL calculator", () => {
  it("BUY SL from M15 S/R invalidation − 0.25 ATR", () => {
    expect(calculateStopLoss({ direction: "BUY", entry: 2651, keyLevel: 2650, m15Structure: st(), atr: 4, now: NOW }))
      .toMatchObject({ ok: true, sl: 2649, source: "M15_SR_INVALIDATION" });
  });
  it("SELL SL from M15 S/R invalidation + 0.25 ATR", () => {
    expect(calculateStopLoss({ direction: "SELL", entry: 2661, keyLevel: 2662, m15Structure: st(), atr: 4, now: NOW }))
      .toMatchObject({ ok: true, sl: 2663, source: "M15_SR_INVALIDATION" });
  });
  it("falls back to confirmed M15 swing when key level is not below entry", () => {
    expect(calculateStopLoss({ direction: "BUY", entry: 2651, keyLevel: 2655, m15Structure: st(), atr: 4, now: NOW }))
      .toMatchObject({ ok: true, sl: 2647, source: "M15_CONFIRMED_SWING" });
  });
  it("no anchor ⇒ NO_SL_ANCHOR (unconfirmed swing ignored)", () => {
    expect(calculateStopLoss({ direction: "BUY", entry: 2651, keyLevel: NaN, m15Structure: st({ lastConfirmedLow: sw("LOW", 2648, NOW + 1) }), atr: 4, now: NOW }))
      .toEqual({ ok: false, reason: "NO_SL_ANCHOR" });
  });
  it("H1/H4 swing never used for scalp SL", () => {
    expect(calculateStopLoss({ direction: "BUY", entry: 2651, keyLevel: NaN, m15Structure: st({ lastConfirmedLow: sw("LOW", 2648, NOW - 900, "H1") }), atr: 4, now: NOW }).ok).toBe(false);
  });
  it("SL too wide ⇒ rejected, not tightened", () => {
    expect(calculateStopLoss({ direction: "BUY", entry: 2661, keyLevel: 2650, m15Structure: st(), atr: 4, now: NOW }))
      .toMatchObject({ ok: false, reason: "SL_TOO_WIDE", anchor: 2650 });
  });
});

describe("M3 TP calculator", () => {
  it("BUY TP = nearest M15 resistance − 0.1 ATR", () => {
    expect(calculateTakeProfit({ direction: "BUY", entry: 2651, m15Structure: st(), atr: 4, now: NOW }))
      .toMatchObject({ ok: true, target: 2662, tp: 2661.6, source: "M15_NEAREST_RESISTANCE" });
  });
  it("SELL TP = nearest M15 support + 0.1 ATR", () => {
    expect(calculateTakeProfit({ direction: "SELL", entry: 2661, m15Structure: st(), atr: 4, now: NOW }))
      .toMatchObject({ ok: true, target: 2648, tp: 2648.4, source: "M15_NEAREST_SUPPORT" });
  });
  it("no resistance above entry ⇒ NO_TP_TARGET", () => {
    expect(calculateTakeProfit({ direction: "BUY", entry: 2680, m15Structure: st(), atr: 4, now: NOW })).toEqual({ ok: false, reason: "NO_TP_TARGET" });
  });
});

describe("M3 trade plan engine", () => {
  it("BUY PLANNED with RR, trace and audit", () => {
    const p = plan();
    expect(p).toMatchObject({ status: "PLANNED", direction: "BUY", entry: 2651, sl: 2649, tp: 2661.6, rr: 5.3, slSource: "M15_SR_INVALIDATION" });
    expect(p.audit).toEqual({ executable: false, orderSent: false, lotCalculated: false, mode: "PLAN_ONLY" });
    expect(p.trace.map((t) => t.result)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
  });
  it("SELL PLANNED", () => {
    expect(plan({ setup: sell(), entry: 2661 })).toMatchObject({ status: "PLANNED", sl: 2663, tp: 2648.4, rr: 6.3 });
  });
  it("BAD_RR ⇒ HOLD, levels kept, SL not moved", () => {
    const p = plan({ m15Structure: st({ lastConfirmedHigh: sw("HIGH", 2653.5), previousHigh: null }) });
    expect(p).toMatchObject({ status: "HOLD", holdReason: "BAD_RR", sl: 2649 });
    expect(p.rr).toBeLessThan(1.2);
  });
  it("RR exactly at minimum is valid", () => {
    // risk 2 ⇒ need reward 2.4 ⇒ tp 2653.4 ⇒ level 2653.8
    expect(plan({ m15Structure: st({ lastConfirmedHigh: sw("HIGH", 2653.8), previousHigh: null }) }).status).toBe("PLANNED");
  });
  it("SL too wide ⇒ HOLD SL_TOO_WIDE", () => {
    expect(plan({ entry: 2661, m15Structure: st({ lastConfirmedHigh: sw("HIGH", 2680) }) })).toMatchObject({ status: "HOLD", holdReason: "SL_TOO_WIDE", sl: null });
  });
  it("no anchor ⇒ HOLD NO_SL_ANCHOR", () => {
    expect(plan({ setup: setup({ keyLevel: 2660 }), m15Structure: st({ lastConfirmedLow: null }) }).holdReason).toBe("NO_SL_ANCHOR");
  });
  it("setup not READY ⇒ HOLD", () => {
    expect(plan({ setup: setup({ state: "REACTION_CONFIRMED" }) }).holdReason).toBe("SETUP_NOT_READY");
    expect(plan({ setup: setup({ state: "EXPIRED" }) }).holdReason).toBe("SETUP_NOT_READY");
  });
  it("non-M15 structure / bad input ⇒ HOLD", () => {
    expect(plan({ m15Structure: st({ timeframe: "H1" }) }).holdReason).toBe("NOT_M15_STRUCTURE");
    expect(plan({ atrM15: 0 }).holdReason).toBe("INVALID_INPUT");
  });
  it("safety: no lot/volume/order fields", () => {
    const p = plan() as unknown as Record<string, unknown>;
    for (const k of ["lot", "lotSize", "volume", "orderId", "ticket", "send"]) expect(p[k]).toBeUndefined();
  });
});
