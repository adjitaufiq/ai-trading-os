import { describe, it } from "vitest";
import { operatorAnalysis } from "@/core/technical/operator";
import { structureOf, type TechBar } from "@/core/technical/indicators";

const TFMS = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
const T0 = 1_700_000_000_000;
const mk = (tf: keyof typeof TFMS, h: number, l: number, i: number): TechBar => {
  const open_time = T0 + i * TFMS[tf];
  return { open_time, close_time: open_time + TFMS[tf], available_at: open_time + TFMS[tf], open: l + (h - l) * 0.3, high: h, low: l, close: l + (h - l) * 0.7 };
};
const series = (tf: keyof typeof TFMS, k: number, f: (i: number) => number): TechBar[] => Array.from({ length: k }, (_, i) => {
  const open_time = T0 + i * TFMS[tf], c = f(i);
  return { open_time, close_time: open_time + TFMS[tf], available_at: open_time + TFMS[tf], open: c, high: c + 0.5, low: c - 0.5, close: c };
});

describe("debug", () => {
  it("prints zones", () => {
    const ZIG = [0, 1, 2, 3, 4, 3, 2, 1];
    const rangeSeries = (i: number) => 100 + 2 * ZIG[i % 8]!;
    const H1 = series("H1", 60, rangeSeries);
    const st = structureOf(H1);
    console.log("H1 structure", st.latest_high, st.latest_low, st.summary);
    const op = operatorAnalysis({ M5: series("M5", 60, rangeSeries), M15: series("M15", 60, rangeSeries), H1, H4: series("H4", 60, rangeSeries) }, 104);
    console.log("regime", op.regime, "zones H1", JSON.stringify(op.zones.H1?.map((z) => ({ role: z.role, touches: z.touches, low: z.low, high: z.high }))));
  });
});
