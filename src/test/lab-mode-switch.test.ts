import { describe, expect, it } from "vitest";
import { allSwitches, defaultSwitches, filterEnabled, parseSwitches } from "@/core/lab/modeSwitch";

describe("lab mode switches", () => {
  it("default turns off modes 1, 3, 4 only", () => {
    const d = defaultSwitches();
    expect(Object.entries(d).filter(([, v]) => !v).map(([k]) => k).sort()).toEqual(["DUAL_WALL", "SNR_PA", "TOUCH_SNR"]);
  });
  it("disabled modes produce no new signals", () => {
    const sig = [{ strategy: "TOUCH_SNR" as const }, { strategy: "FAST_BREAKOUT" as const }];
    expect(filterEnabled(sig, defaultSwitches()).map((s) => s.strategy)).toEqual(["FAST_BREAKOUT"]);
    expect(filterEnabled(sig, allSwitches(false))).toEqual([]);
  });
  it("persisted values override defaults", () => {
    expect(parseSwitches({ TOUCH_SNR: true }).TOUCH_SNR).toBe(true);
  });
});
