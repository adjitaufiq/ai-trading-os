import { describe, it, expect } from "vitest";
import { copetParams } from "./labLedger";
import { LAB_RISK_POLICY_FILE_CONTENT as P } from "./demo/labRiskPolicy";
const floor = (peak: number, arm: number, gap: number) => (peak >= arm ? peak - gap : null);
describe("COPET operator targets", () => {
  for (const s of ["XAUUSD", "BTCUSD"]) {
    it(`${s} paper: arm $3, peak $3 → floor $2, peak $7 → floor $6, SL $10`, () => {
      const c = copetParams(s);
      expect(c.SL_USD).toBe(10);
      expect(floor(3, c.TRAIL_ARM_USD, c.TRAIL_GAP_USD)).toBe(2);
      expect(floor(7, c.TRAIL_ARM_USD, c.TRAIL_GAP_USD)).toBe(6);
    });
  }
  it("runner policy matches paper", () => {
    const b = (P as any).copet.BTCUSD;
    expect(b.sl_usd).toBe(10);
    expect(floor(7, b.trail_arm_usd, b.trail_gap_usd)).toBe(6);
    expect(b.sl_usd / (b.lot * b.contract_size_assumed)).toBe(200);
  });
});
