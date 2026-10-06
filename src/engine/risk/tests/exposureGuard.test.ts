import { describe, expect, it } from "vitest";
import { checkExposure } from "../exposureGuard";

const L = { maxSymbolRiskUSD: 200, maxTotalRiskUSD: 300 };

describe("exposure guard", () => {
  it("clusters all positions of the same symbol", () => {
    const r = checkExposure("XAUUSD", [{ symbol: "XAUUSD", riskUSD: 100 }, { symbol: "XAUUSD", riskUSD: 80 }], L, 30);
    expect(r.symbolRiskUSD).toBe(180); expect(r.ok).toBe(false); expect(r.remainingUSD).toBe(20);
  });
  it("other symbols count only toward total", () => {
    const r = checkExposure("XAUUSD", [{ symbol: "BTCUSD", riskUSD: 250 }], L, 60);
    expect(r.symbolRiskUSD).toBe(0); expect(r.ok).toBe(false); expect(r.remainingUSD).toBe(50);
  });
  it("within caps passes", () => expect(checkExposure("XAUUSD", [], L, 100).ok).toBe(true));
});
