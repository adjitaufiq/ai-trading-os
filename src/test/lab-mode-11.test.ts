import { describe, expect, it } from "vitest";
import { evaluateLabDetailed, LAB_STRATEGIES } from "@/core/lab/strategies";
import { bookStats, createBook } from "@/core/lab/isolatedLedgers";
import type { TechBar } from "@/core/technical/indicators";

const M5 = 300_000, M15 = 900_000;
const mk = (i: number, tf: number, o: number, h: number, l: number, c: number): TechBar => ({ open_time: i * tf, close_time: (i + 1) * tf, available_at: (i + 1) * tf, open: o, high: h, low: l, close: c });

describe("lab mode 11 S/R + EMA 5/21", () => {
  it("is registered with its own NORMAL and COPET ledgers", () => {
    expect(LAB_STRATEGIES).toContain("DUAL_WALL_FAST");
    expect(bookStats(createBook(1)).filter((s) => s.strategy === "DUAL_WALL_FAST").map((s) => s.profile).sort()).toEqual(["COPET", "NORMAL"]);
  });
  it("BUY at M15 support near EMA5/21 on a bullish closed M5 bar; no signal on bearish bar", () => {
    // M15: swing low at 90 (bar 10), otherwise around 100.
    const m15 = Array.from({ length: 40 }, (_, i) => i === 10 ? mk(i, M15, 95, 96, 90, 95) : mk(i, M15, 100, 101, 99, 100));
    const m5base = Array.from({ length: 79 }, (_, i) => mk(i + 200, M5, 90.5, 91, 90, 90.5));
    const bull = evaluateLabDetailed([...m5base, mk(279, M5, 90.2, 90.9, 90, 90.7)], m15);
    expect(bull.signals.find((s) => s.strategy === "DUAL_WALL_FAST")?.side).toBe("BUY");
    const bear = evaluateLabDetailed([...m5base, mk(279, M5, 90.7, 90.9, 90, 90.2)], m15);
    expect(bear.signals.some((s) => s.strategy === "DUAL_WALL_FAST" && s.side === "BUY")).toBe(false);
  });
});
