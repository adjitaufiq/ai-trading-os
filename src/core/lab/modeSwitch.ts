// Strategy Lab mode on/off switches (PAPER only). A disabled mode opens no NEW virtual positions;
// open ones keep being marked and close naturally. Never touches strategy logic or RR params.
import { LAB_STRATEGIES, type LabStrategy } from "./strategies";

export type ModeSwitches = Record<LabStrategy, boolean>;
export const MODE_SWITCH_KEY = "strategy-lab-enabled-modes-v1";
const DEFAULT_OFF: readonly LabStrategy[] = ["TOUCH_SNR", "SNR_PA", "DUAL_WALL"];

export function defaultSwitches(): ModeSwitches {
  return Object.fromEntries(LAB_STRATEGIES.map((s) => [s, !DEFAULT_OFF.includes(s)])) as ModeSwitches;
}
export function parseSwitches(raw: unknown): ModeSwitches {
  const d = defaultSwitches();
  if (!raw || typeof raw !== "object") return d;
  for (const s of LAB_STRATEGIES) { const v = (raw as Record<string, unknown>)[s]; if (typeof v === "boolean") d[s] = v; }
  return d;
}
export function allSwitches(on: boolean): ModeSwitches {
  return Object.fromEntries(LAB_STRATEGIES.map((s) => [s, on])) as ModeSwitches;
}
export function filterEnabled<T extends { strategy: LabStrategy }>(signals: readonly T[], sw: ModeSwitches): T[] {
  return signals.filter((s) => sw[s.strategy] === true);
}
