// H4 closed-bar authority for primary_bias (production path: mergeClosedHistory filter → operatorAnalysis).
import { describe, expect, it } from "vitest";
import type { TechBar } from "@/core/technical/indicators";
import { operatorAnalysis } from "@/core/technical/operator";
import { mergeClosedHistory } from "@/core/technical/TechnicalSliceService";

const TF = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
type K = keyof typeof TF;
const T0 = 1_700_000_000_000;
const series = (tf: K, closes: number[], start = T0): TechBar[] => closes.map((c, i) => {
  const open_time = start + i * TF[tf];
  return { open_time, close_time: open_time + TF[tf], available_at: open_time + TF[tf], open: c, high: c + 0.5, low: c - 0.5, close: c };
});
const ZIG = [0, 1, 2, 3, 4, 3, 2, 1];
const down = (k: number, from = 200) => Array.from({ length: k }, (_, i) => from - i * 0.3 - ZIG[i % 8]!);
const up = (k: number, from: number) => Array.from({ length: k }, (_, i) => from + i * 0.3 + ZIG[i % 8]!);
const flat = (k: number, at: number) => Array.from({ length: k }, () => at);

const H4_DOWN = series("H4", down(60));
const lastClose = H4_DOWN.at(-1)!.close;
const lower = { M5: series("M5", flat(50, lastClose)), M15: series("M15", flat(60, lastClose)), H1: series("H1", flat(60, lastClose)) };
const asOfAfter = (bars: TechBar[]) => bars.at(-1)!.available_at;
const h4Input = (bars: TechBar[], asOf: number) => mergeClosedHistory(bars, [], null, asOf);
const analyse = (h4: TechBar[], price = lastClose) => operatorAnalysis({ ...lower, H4: h4 }, price);

describe("H4 primary_bias — CLOSED H4 is the only authority", () => {
  it("valid CLOSED bearish H4 ⇒ primary_bias SELL", () => {
    expect(analyse(h4Input(H4_DOWN, asOfAfter(H4_DOWN))).primary_bias).toBe("SELL");
  });

  it("forming bullish H4 (available_at > asOf) is excluded from the H4 input and cannot flip SELL or create a BUY", () => {
    const asOf = asOfAfter(H4_DOWN);
    const last = H4_DOWN.at(-1)!;
    const forming: TechBar = { open_time: last.close_time, close_time: last.close_time + TF.H4, available_at: last.close_time + TF.H4, open: lastClose, high: lastClose + 40, low: lastClose - 0.5, close: lastClose + 39 };
    const input = h4Input([...H4_DOWN, forming], asOf + TF.H4 / 2);
    expect(input).toHaveLength(H4_DOWN.length);
    expect(input.some((b) => b.open_time === forming.open_time)).toBe(false);
    const op = analyse(input, lastClose + 39);
    expect(op.primary_bias).toBe("SELL");
    expect(op.candidate).not.toBe("BUY");
  });

  it("only after a sustained reversal is CLOSED with available_at <= asOf may primary_bias change (existing structure+EMA rule)", () => {
    const rev = series("H4", up(60, lastClose), H4_DOWN.at(-1)!.close_time);
    const all = [...H4_DOWN, ...rev];
    // Same bars, but asOf before they close: still SELL.
    expect(analyse(h4Input(all, asOfAfter(H4_DOWN))).primary_bias).toBe("SELL");
    // Once CLOSED and knowable: the existing rule may now flip direction.
    const op = analyse(h4Input(all, asOfAfter(all)), rev.at(-1)!.close);
    expect(op.primary_bias).toBe("BUY");
  });
});
