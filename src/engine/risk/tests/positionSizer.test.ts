import { describe, expect, it } from "vitest";
import { calculatePositionSize, floorToStep } from "../positionSizer";
import type { BrokerSymbolInfo } from "../types";

const XAU: BrokerSymbolInfo = { symbol: "XAUUSD", volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, marginPerLot: 1000 };

describe("position sizer", () => {
  it("floors to volume step, never rounds", () => {
    expect(floorToStep(0.0199, 0.01)).toBe(0.01);
    expect(floorToStep(0.029999, 0.01)).toBe(0.02);
    expect(floorToStep(0.03, 0.01)).toBe(0.03);
  });
  it("percentage budget: 10000×1%=100 USD, SL 5.00 ⇒ 0.2 lot", () => {
    const r = calculatePositionSize(100, 5, XAU, true)!;
    expect(r.rawLot).toBeCloseTo(0.2); expect(r.finalLot).toBe(0.2); expect(r.actualRiskUSD).toBe(100);
  });
  it("fixed USD budget floors and reports negative deviation", () => {
    const r = calculatePositionSize(37, 5, XAU, true)!; // raw 0.074
    expect(r.finalLot).toBe(0.07); expect(r.actualRiskUSD).toBe(35); expect(r.riskDeviationPercent).toBeCloseTo(-5.41, 1);
  });
  it("strict: below min lot stays below", () => {
    const r = calculatePositionSize(2, 5, XAU, true)!;
    expect(r.finalLot).toBe(0); expect(r.forcedMinimumLot).toBe(false);
  });
  it("non-strict: forced min lot with real risk deviation", () => {
    const r = calculatePositionSize(2, 5, XAU, false)!;
    expect(r.finalLot).toBe(0.01); expect(r.forcedMinimumLot).toBe(true); expect(r.actualRiskUSD).toBe(5); expect(r.riskDeviationPercent).toBe(150);
  });
  it("caps at volumeMax and rejects invalid inputs", () => {
    expect(calculatePositionSize(1e9, 1, XAU, true)!.finalLot).toBe(100);
    expect(calculatePositionSize(100, 0, XAU, true)).toBeNull();
  });
});
