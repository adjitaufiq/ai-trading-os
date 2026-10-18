import { describe, it, expect } from "vitest";
import { DEFAULT_OPERATOR } from "@/core/lab/operatorControl";
describe("Mode 13 GOLD_SNIPER defaults", () => {
  it("XAU quota 1, BTC quota 0", () => {
    expect(DEFAULT_OPERATOR.marketQuota.GOLD_SNIPER).toEqual({ XAUUSD: 1, BTCUSD: 0 });
  });
});
