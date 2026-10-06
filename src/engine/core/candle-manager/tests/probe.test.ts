import { it, expect } from "vitest";
import { ClosedCandleManager, calculationLockGate } from "../closedCandleManager";
import { evaluateCandleStatus } from "../closedCandleManager";
it("probe", () => {
  expect(ClosedCandleManager).toBeDefined();
  expect(calculationLockGate).toBeDefined();
  expect(evaluateCandleStatus).toBeDefined();
});
