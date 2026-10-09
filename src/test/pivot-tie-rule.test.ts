// Pivot tie-rule B (operator-v2.4-pivot-tie-first-owner) regression tests.
// Rule B: LEFT neighbours strictly beyond the pivot, RIGHT neighbours may equal.
// First bar of an equal high/low run owns the pivot. confirmedAt unchanged (open + 3 × tf).
// The research probe keeps its own STRICT rule and has no trading authority (probe test #24 unchanged).
import { describe, expect, it } from "vitest";
import { causalSwings, structureOf, type TechBar } from "@/core/technical/indicators";
import { OPERATOR_POLICY_VERSION, operatorAnalysis } from "@/core/technical/operator";

const TFMS = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
type K = keyof typeof TFMS;
const T0 = 1_700_000_000_000;
const mk = (tf: K, h: number, l: number, i: number): TechBar => {
  const open_time = T0 + i * TFMS[tf];
  const close_time = open_time + TFMS[tf];
  return { open_time, close_time, available_at: close_time, open: l + (h - l) * 0.3, high: h, low: l, close: l + (h - l) * 0.7 };
};
const highs = (tf: K, rows: number[], lo = (h: number, i: number) => h - 1) => rows.map((h, i) => mk(tf, h, lo(h, i), i));
const series = (tf: K, k: number, f: (i: number) => number): TechBar[] => Array.from({ length: k }, (_, i) => {
  const open_time = T0 + i * TFMS[tf], c = f(i);
  return { open_time, close_time: open_time + TFMS[tf], available_at: open_time + TFMS[tf], open: c, high: c + 0.5, low: c - 0.5, close: c };
});

describe("ARENA causalSwings — tie rule B (left strict, right allows equality)", () => {
  it("A. equal HIGH on the right side: the first bar of the run owns the pivot", () => {
    const bars = highs("M15", [10, 11, 15, 15, 12]);
    const hs = causalSwings(bars).filter((s) => s.kind === "HIGH");
    expect(hs).toHaveLength(1);
    expect(hs[0]!.pivot_time).toBe(bars[2]!.open_time);
    expect(hs[0]!.price).toBe(15);
  });
  it("B. equal LOW on the right side: mirror rule", () => {
    const bars = Array.from({ length: 5 }, (_, i) => mk("M15", 10 - i * 0.2, [10, 9, 5, 5, 6][i]!, i));
    const ls = causalSwings(bars).filter((s) => s.kind === "LOW");
    expect(ls).toHaveLength(1);
    expect(ls[0]!.pivot_time).toBe(bars[2]!.open_time);
    expect(ls[0]!.price).toBe(5);
  });
  it("C/D. HIGH and LOW plateau: exactly one pivot at the first bar of the run", () => {
    const hp = causalSwings(highs("M15", [10, 11, 15, 15, 15, 12, 11])).filter((s) => s.kind === "HIGH");
    expect(hp).toHaveLength(1);
    expect(hp[0]!.pivot_time).toBe(T0 + 2 * TFMS.M15);
    const lp = causalSwings(Array.from({ length: 7 }, (_, i) => mk("M15", 12 - i * 0.2, [10, 9, 5, 5, 5, 8, 9][i]!, i))).filter((s) => s.kind === "LOW");
    expect(lp).toHaveLength(1);
    expect(lp[0]!.pivot_time).toBe(T0 + 2 * TFMS.M15);
  });
  it("E. equal LEFT neighbour is still rejected (left stays strict)", () => {
    const bars = highs("M15", [10, 15, 15, 13, 12]);
    expect(causalSwings(bars).filter((s) => s.kind === "HIGH")).toHaveLength(0);
    expect(causalSwings(bars).filter((s) => s.kind === "LOW")).toHaveLength(0);
  });
  it("F. no duplicate pivots on an equal run", () => {
    const bars = highs("M15", [10, 11, 15, 15, 15, 12, 11]);
    const hs = causalSwings(bars).filter((s) => s.kind === "HIGH");
    const times = hs.map((s) => s.pivot_time);
    expect(new Set(times).size).toBe(times.length);
  });
  it("G. confirmed_at = right bar #2 close; needs both right bars", () => {
    const bars = highs("M15", [10, 11, 15, 15, 12]);
    const hs = causalSwings(bars).filter((s) => s.kind === "HIGH");
    expect(hs[0]!.confirmed_at).toBe(bars[4]!.close_time);
    expect(hs[0]!.available_at).toBe(bars[4]!.available_at);
    expect(causalSwings(bars.slice(0, 4))).toHaveLength(0); // missing right bar → no pivot
  });
  it("H. short/insufficient window yields no pivot", () => {
    const bars = highs("M15", [10, 11, 15, 15]);
    expect(causalSwings(bars)).toHaveLength(0);
    expect(causalSwings(bars.slice(0, 3))).toHaveLength(0);
  });
  it("I. HIGH: a right neighbour STRICTLY HIGHER than the candidate rejects it", () => {
    const bars = highs("M15", [10, 11, 15, 16, 12]);
    expect(causalSwings(bars).filter((s) => s.kind === "HIGH" && s.pivot_time === bars[2]!.open_time)).toHaveLength(0);
    const bars2 = highs("M15", [10, 11, 15, 12, 16]);
    expect(causalSwings(bars2).filter((s) => s.kind === "HIGH" && s.pivot_time === bars2[2]!.open_time)).toHaveLength(0);
  });
  it("J. LOW: a right neighbour STRICTLY LOWER than the candidate rejects it", () => {
    const bars = Array.from({ length: 5 }, (_, i) => mk("M15", 10 - i * 0.2, [10, 9, 5, 4, 6][i]!, i));
    expect(causalSwings(bars).filter((s) => s.kind === "LOW" && s.pivot_time === bars[2]!.open_time)).toHaveLength(0);
    const bars2 = Array.from({ length: 5 }, (_, i) => mk("M15", 10 - i * 0.2, [10, 9, 5, 6, 4][i]!, i));
    expect(causalSwings(bars2).filter((s) => s.kind === "LOW" && s.pivot_time === bars2[2]!.open_time)).toHaveLength(0);
  });
  it("structureOf: equal run produces EQUAL_HIGH, not a skipped bar", () => {
    const bars = highs("M15", [10, 11, 15, 15, 12, 13, 15, 15, 13, 12]);
    const s = structureOf(bars);
    expect(s.latest_high).toBe("EQUAL_HIGH");
  });
});

describe("Primary bias regression — double top via tie-run under operatorAnalysis", () => {
  it("operator-v2.4: an equal-run high becomes a pivot → EQUAL_HIGH → MIXED → primary_bias NONE / WAIT", () => {
    expect(OPERATOR_POLICY_VERSION).toBe("operator-v2.4-pivot-tie-first-owner");
    // H4 fixture: ramp (no pivots) + lower pivot 104 + higher pivot 106 + equal-run plateau at the end.
    // Under rule B: high pivots 104 (FIRST), 106 (HH), 106 (EQUAL_HIGH) → MIXED.
    // Under the old strict rule the plateau pivot was dropped → HH_HL + rising EMAs → stale BUY.
    const ramp = (i: number) => 100 + i * 0.05;
    const hiRows: number[] = [], loRows: number[] = [];
    for (let i = 0; i < 49; i++) { hiRows.push(ramp(i)); loRows.push(ramp(i) - 1); }
    const patternH = [102.0, 102.6, 104.0, 103.0, 102.8, 106.0, 103.5, 103.2, 106.0, 106.0, 104.0];
    const patternL = [101.9, 101.7, 101.0, 101.8, 101.6, 101.9, 101.5, 101.2, 101.5, 101.6, 101.8];
    hiRows.push(...patternH); loRows.push(...patternL);
    const H4: TechBar[] = hiRows.map((h, i) => mk("H4", h, loRows[i]!, i));

    // Direct structure check: latest HIGH swing label is EQUAL_HIGH, summary MIXED.
    const st = structureOf(H4);
    expect(st.latest_high).toBe("EQUAL_HIGH");
    expect(st.summary).toBe("MIXED");

    const ZIG = [0, 1, 2, 3, 4, 3, 2, 1];
    const upSeries = (i: number) => 100 + i * 0.3 + ZIG[i % 8]!;
    const rangeSeries = (i: number) => 100 + 2 * ZIG[i % 8]!;
    const closed = { M5: series("M5", 60, upSeries), M15: series("M15", 60, upSeries), H1: series("H1", 60, rangeSeries), H4 } as const;
    const price = 103;
    const op = operatorAnalysis(closed, price);
    expect(op.h4_primary).toBe("MIXED");
    expect(op.primary_bias).toBeNull();
    expect(op.candidate).toBeNull();
    expect(op.reason).toBe("NO_PRIMARY_BIAS_H4_MIXED");
  });
});
