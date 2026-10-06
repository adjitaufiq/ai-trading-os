import { describe, expect, it } from "vitest";
import type { ArenaCandle } from "../../normalizer/types";
import { calculateEMA } from "../emaCalculator";
import { computeEMAContext } from "../emaStateEngine";
import { bar, range, series } from "./helpers";

const ctx = (c: ArenaCandle[]) => {
  const r = computeEMAContext(c, 1);
  if (!r.ok) throw new Error(r.reason);
  return r.context;
};
const lastEma = (c: ArenaCandle[], p: number) => (calculateEMA(c, p) as number[]).at(-1)!;
const up = () => series(range(120, (i) => 2600 + i * 0.5));
const down = () => series(range(120, (i) => 2700 - i * 0.5));
function push(c: ArenaCandle[], open: number, close: number, high?: number, low?: number) {
  c.push(bar(c.length, open, close, high, low));
}

describe("M1B.6 EMA state engine", () => {
  it("rising EMA21 + ABOVE_ALL in uptrend", () => {
    const x = ctx(up());
    expect(x.slope21).toBe("RISING");
    expect(x.pricePosition).toBe("ABOVE_ALL");
    expect(x.actions).toContain("EMA5_ABOVE_EMA21");
  });

  it("falling EMA21 + BELOW_ALL in downtrend", () => {
    const x = ctx(down());
    expect(x.slope21).toBe("FALLING");
    expect(x.pricePosition).toBe("BELOW_ALL");
    expect(x.actions).toContain("EMA5_BELOW_EMA21");
  });

  it("flat EMA on flat series, no compression/expansion", () => {
    const x = ctx(series(range(120, () => 2600)));
    expect(x.slope21).toBe("FLAT");
    expect(x.slope50).toBe("FLAT");
    expect(x.compression).toBe(false);
    expect(x.expansion).toBe(false);
  });

  it("EMA21 retest after being away", () => {
    const c = up();
    const e = lastEma(c, 21);
    push(c, c.at(-1)!.close, e);
    const x = ctx(c);
    expect(x.actions).toContain("EMA21_RETEST");
    expect(x.distanceToEMA21).toBeLessThan(0.5);
  });

  it("EMA21 bullish rejection", () => {
    const c = up();
    const e = lastEma(c, 21);
    push(c, c.at(-1)!.close, e); // touches EMA21
    const e2 = lastEma(c, 21);
    push(c, e, e2 + 3);
    expect(ctx(c).actions).toContain("EMA21_REJECT_UP");
  });

  it("EMA21 bearish rejection", () => {
    const c = down();
    const e = lastEma(c, 21);
    push(c, c.at(-1)!.close, e);
    const e2 = lastEma(c, 21);
    push(c, e, e2 - 3);
    expect(ctx(c).actions).toContain("EMA21_REJECT_DOWN");
  });

  it("EMA50 support", () => {
    const c = up();
    const e50 = lastEma(c, 50);
    push(c, c.at(-1)!.close, e50);
    const e2 = lastEma(c, 50);
    push(c, e50, e2 + 3);
    const x = ctx(c);
    expect(x.actions).toContain("EMA50_SUPPORT");
    expect(x.actions).not.toContain("EMA50_RESISTANCE");
  });

  it("EMA50 resistance", () => {
    const c = down();
    const e50 = lastEma(c, 50);
    push(c, c.at(-1)!.close, e50);
    const e2 = lastEma(c, 50);
    push(c, e50, e2 - 3);
    expect(ctx(c).actions).toContain("EMA50_RESISTANCE");
  });

  it("compression after trend goes flat", () => {
    const closes = [...range(100, (i) => 2600 + i * 0.5), ...range(60, () => 2649.5)];
    const x = ctx(series(closes));
    expect(x.compression).toBe(true);
    expect(x.actions).toContain("EMA_COMPRESSION");
  });

  it("expansion on accelerating trend", () => {
    const closes = [...range(100, () => 2600), ...range(20, (i) => 2600 + 0.1 * (i + 1) ** 2)];
    const x = ctx(series(closes));
    expect(x.expansion).toBe(true);
    expect(x.actions).toContain("EMA_EXPANSION");
  });

  it("BETWEEN_EMA21_EMA50 classification", () => {
    const c = up();
    const mid = (lastEma(c, 21) + lastEma(c, 50)) / 2;
    push(c, c.at(-1)!.close, mid);
    expect(ctx(c).pricePosition).toBe("BETWEEN_EMA21_EMA50");
  });

  it("insufficient history and invalid timeframe", () => {
    expect(computeEMAContext(series(range(99, () => 1)), 1)).toEqual({ ok: false, reason: "INSUFFICIENT_HISTORY" });
    const h1 = up().map((b) => ({ ...b, timeframe: "H1" as const }));
    expect(computeEMAContext(h1, 1)).toEqual({ ok: false, reason: "INVALID_TIMEFRAME" });
  });

  it("running candle ignored (no repaint)", () => {
    const c = up();
    const base = ctx(c);
    const run = [...c, bar(c.length, 2660, 1000, 2660, 1000, false)];
    expect(ctx(run).values).toEqual(base.values);
  });

  it("never emits signal-like fields", () => {
    const x = ctx(up()) as unknown as Record<string, unknown>;
    for (const k of ["side", "signal", "sl", "tp", "entry"]) expect(x[k]).toBeUndefined();
  });
});
