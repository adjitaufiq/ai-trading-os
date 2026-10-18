import { describe, expect, it } from "vitest";
import { evaluateLabDetailed } from "@/core/lab/strategies";
import type { TechBar } from "@/core/technical/indicators";

const M5 = 300_000, M15 = 900_000, H1 = 3_600_000;
const mk = (i: number, tf: number, o: number, h: number, l: number, c: number): TechBar => ({ open_time: i * tf, close_time: (i + 1) * tf, available_at: (i + 1) * tf, open: o, high: h, low: l, close: c });
const m15 = Array.from({ length: 40 }, (_, i) => i === 10 ? mk(i, M15, 95, 96, 90, 95) : mk(i, M15, 100, 101, 99, 100));
const m5base = Array.from({ length: 79 }, (_, i) => mk(i + 200, M5, 90.5, 91, 90, 90.5));
const bullBar = mk(279, M5, 90.2, 90.9, 90, 90.7);
const bearMarubozu = mk(279, M5, 90.9, 90.9, 90, 90.0);
// H1 bars all closed before the M5 bar closes (~23.3h).
const h1Trend = (dir: 1 | -1) => Array.from({ length: 22 }, (_, i) => { const p = 100 + dir * i * 2; return mk(i, H1, p, p + 1, p - 1, p + dir); });
const touchBuy = (m5: TechBar[], h1: TechBar[]) => evaluateLabDetailed(m5, m15, h1).signals.some((s) => s.strategy === "TOUCH_SNR" && s.side === "BUY");

describe("mode 1 TOUCH_SNR H1 EMA9/21 compass + M5 candle", () => {
  it("blocks BUY at support when H1 is DOWN", () => {
    expect(touchBuy([...m5base, bullBar], h1Trend(-1))).toBe(false);
  });
  it("allows BUY at support when H1 is UP and M5 candle is bullish", () => {
    expect(touchBuy([...m5base, bullBar], h1Trend(1))).toBe(true);
  });
  it("blocks BUY on a bearish marubozu even when H1 is UP", () => {
    expect(touchBuy([...m5base, bearMarubozu], h1Trend(1))).toBe(false);
  });
});
