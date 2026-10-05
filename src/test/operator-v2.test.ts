import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import { ema, structureOf, type TechBar } from "@/core/technical/indicators";
import {
  OPERATOR_PARAMS, buildZones, eveningStarLike, h1Context, hammerLike, morningStarLike, operatorAnalysis, readPatterns, rejectionWick, shootingStarLike, trendState,
} from "@/core/technical/operator";
import { evaluate, type EvaluationInput } from "@/core/technical/tradingState";

const TF = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
type K = keyof typeof TF;
const series = (tf: K, closes: number[], start = 1_700_000_000_000): TechBar[] => closes.map((c, i) => {
  const open_time = start + i * TF[tf];
  return { open_time, close_time: open_time + TF[tf], available_at: open_time + TF[tf], open: c, high: c + 0.5, low: c - 0.5, close: c };
});
const ZIG = [0, 1, 2, 3, 4, 3, 2, 1];
const up = (k: number) => Array.from({ length: k }, (_, i) => 100 + i * 0.3 + ZIG[i % 8]!);
const down = (k: number) => Array.from({ length: k }, (_, i) => 200 - i * 0.3 - ZIG[i % 8]!);
const range = (k: number) => Array.from({ length: k }, (_, i) => 100 + 2 * ZIG[i % 8]!);
const ok = (value: number) => ({ status: "OK" as const, value, as_of_bar: 1 });
const b = (o: number, h: number, l: number, c: number, i = 0): TechBar => ({ open_time: i, close_time: i + 1, available_at: i + 1, open: o, high: h, low: l, close: c });
const withLast = (bars: TechBar[], ...last: [number, number, number, number][]) => {
  const out = [...bars];
  last.forEach((x, j) => { const at = out.length - last.length + j; const p = out[at]!; out[at] = { ...p, open: x[0], high: x[1], low: x[2], close: x[3] }; });
  return out;
};
const input = (closed: EvaluationInput["closed"], price: number): EvaluationInput => ({
  symbol: "XAUUSD", market_current: true, bars_current: true, quote: { bid: price - 0.1, ask: price + 0.1, spread: 0.2, tick_time_ms: 1, observed_at: 2 },
  closed, as_of: 1e15, env: { operating_mode: "MONITOR_ONLY", execution_enabled: false },
});

describe("operator v2 — trend model & H1 context", () => {
  it("per-TF trend needs EMA21/EMA50 AND structure; single factor is never enough", () => {
    expect(trendState(ok(2), ok(1), "HH_HL")).toBe("UP");
    expect(trendState(ok(1), ok(2), "LH_LL")).toBe("DOWN");
    expect(trendState(ok(2), ok(1), "LH_LL")).toBe("MIXED");
    expect(trendState(ok(2), ok(1), "MIXED")).toBe("MIXED");
    expect(trendState({ status: "INSUFFICIENT_HISTORY", required: 50, have: 40 }, ok(1), "HH_HL")).toBe("INSUFFICIENT");
  });
  it("H4 DOWN + H1 temporary UP = PULLBACK_AGAINST_H4, not NEUTRAL", () => {
    expect(h1Context("DOWN", "MIXED", "UP", null)).toBe("PULLBACK_AGAINST_H4");
  });
  it("H1 returning DOWN after pullback = RETURNING_TO_H4", () => {
    const lh = { kind: "HIGH" as const, price: 1, pivot_time: 0, confirmed_at: 1, available_at: 1, outside_bar: false, label: "LH" as const };
    expect(h1Context("DOWN", "MIXED", "DOWN", lh)).toBe("RETURNING_TO_H4");
    expect(h1Context("DOWN", "UP", "UP", null)).toBe("REVERSAL_CANDIDATE");
    expect(h1Context("DOWN", "DOWN", "DOWN", lh)).toBe("ALIGNED");
  });
  it("bullish mirror", () => {
    const hl = { kind: "LOW" as const, price: 1, pivot_time: 0, confirmed_at: 1, available_at: 1, outside_bar: false, label: "HL" as const };
    expect(h1Context("UP", "MIXED", "DOWN", null)).toBe("PULLBACK_AGAINST_H4");
    expect(h1Context("UP", "MIXED", "UP", hl)).toBe("RETURNING_TO_H4");
    expect(h1Context("MIXED", "UP", "UP", hl)).toBe("NO_PRIMARY_DIRECTION");
  });
});

describe("operator v2 — S/R zones & regime", () => {
  it("clusters confirmed swings within 0.5×ATR into one zone with touches, role, distance", () => {
    const sw = (price: number, kind: "HIGH" | "LOW", t: number) => ({ kind, price, pivot_time: t, confirmed_at: t + 2, available_at: t + 2, outside_bar: false, label: "FIRST" as const });
    const zones = buildZones([sw(100, "LOW", 1), sw(100.4, "LOW", 5), sw(100.2, "HIGH", 9), sw(110, "HIGH", 3)], "H1", ok(1), 105);
    expect(zones).toHaveLength(2);
    expect(zones[0]).toMatchObject({ low: 100, high: 100.4, touches: 3, swing_lows: 2, swing_highs: 1, role: "SUPPORT", latest_touch_at: 11, source_tf: "H1" });
    expect(zones[0]!.distance).toBeCloseTo(4.6, 10);
    expect(zones[1]).toMatchObject({ low: 110, high: 110, touches: 1, role: "RESISTANCE" });
    expect(OPERATOR_PARAMS.zone_cluster_tolerance_atr).toBe(0.5);
  });
  it("range recognised only with bounded repeated zones; middle of range ⇒ HOLD", () => {
    const closed = { M5: series("M5", range(60)), M15: series("M15", range(60)), H1: series("H1", range(60)), H4: series("H4", range(60)) };
    const mid = operatorAnalysis(closed, 104);
    expect(mid.h4_primary).toBe("MIXED");
    expect(mid.regime).toBe("RANGE");
    expect(mid.location).toBe("MID");
    expect(mid.status).toBe("HOLD");
    expect(evaluate(input(closed, 104)).entry.state).toBe("WAIT");
    // Same flat oscillation without enough history for repeated touches ⇒ not a range.
    const short = { M5: series("M5", range(60)), M15: series("M15", range(60)), H1: series("H1", range(60).slice(0, 52)).slice(-7), H4: series("H4", range(60)) };
    expect(operatorAnalysis(short, 104).regime).toBe("CHOPPY");
  });
  it("range BUY at support needs a CLOSED bullish trigger", () => {
    const base = { M15: series("M15", range(60)), H1: series("H1", range(60)), H4: series("H4", range(60)) };
    const noTrig = operatorAnalysis({ ...base, M5: series("M5", range(60)) }, 100);
    expect(noTrig).toMatchObject({ regime: "RANGE", location: "AT_SUPPORT", status: "HOLD", candidate: null });
    // P0.2: range BUY also needs a local bullish M5 momentum side.
    const hammer = withLast(series("M5", Array.from({ length: 50 }, (_, i) => 95 + 0.1 * i)), [99.8, 100.1, 98.6, 100]);
    const s = evaluate(input({ ...base, M5: hammer }, 100));
    expect(s.operator!.patterns.M5.bullish).toContain("HAMMER_LIKE");
    expect(s.entry.state).toBe("LONG_CANDIDATE");
  });
});

describe("operator v2 — trend setups", () => {
  it("trend SELL: H4 DOWN, resistance/EMA confluence, H1 RSI < 50, CLOSED bearish trigger", () => {
    const H1 = series("H1", down(60));
    const price = (ema(H1, 21) as { value: number }).value;
    const m5 = withLast(series("M5", down(40)), [179, 180.2, 178.8, 180], [180.1, 180.3, 177, 177.5]);
    const s = evaluate(input({ M5: m5, M15: series("M15", down(60)), H1, H4: series("H4", down(60)) }, price));
    expect(s.operator).toMatchObject({ h4_primary: "DOWN", regime: "TREND", status: "CARI_SELL", candidate: "SELL" });
    expect(s.operator!.checks).toEqual({ context: true, location: true, rsi: true, trigger: true });
    expect(s.entry.state).toBe("SHORT_CANDIDATE");
    expect(s.reference_plan.status).toBe("AVAILABLE");
    if (s.reference_plan.status === "AVAILABLE") expect(s.reference_plan.structural).toBeDefined();
    expect(s.execution.state).toBe("BLOCKED");
  });
  it("trend BUY mirror", () => {
    const H1 = series("H1", up(60));
    const price = (ema(H1, 21) as { value: number }).value;
    const m5 = withLast(series("M5", up(40)), [120, 120.2, 118.8, 119], [118.9, 121.2, 118.7, 121]);
    const s = evaluate(input({ M5: m5, M15: series("M15", up(60)), H1, H4: series("H4", up(60)) }, price));
    expect(s.operator).toMatchObject({ h4_primary: "UP", status: "CARI_BUY", candidate: "BUY" });
    expect(s.entry.state).toBe("LONG_CANDIDATE");
  });
  it("trend without location ⇒ HOLD even with a trigger", () => {
    const m5 = withLast(series("M5", up(40)), [120, 120.2, 118.8, 119], [118.9, 121.2, 118.7, 121]);
    const s = evaluate(input({ M5: m5, M15: series("M15", up(60)), H1: series("H1", up(60)), H4: series("H4", up(60)) }, 500));
    expect(s.operator!.checks.location).toBe(false);
    expect(s.entry.state).toBe("WAIT");
  });
  it("forming candle never triggers: the same pattern excluded from CLOSED input ⇒ no candidate", () => {
    const H1 = series("H1", up(60));
    const price = (ema(H1, 21) as { value: number }).value;
    const m5 = withLast(series("M5", up(40)), [120, 120.2, 118.8, 119], [118.9, 121.2, 118.7, 121]).slice(0, -1);
    const s = evaluate(input({ M5: m5, M15: series("M15", up(60)), H1, H4: series("H4", up(60)) }, price));
    expect(s.entry.state).toBe("WAIT");
  });
});

describe("operator v2 — candle patterns (candle-patterns-v1)", () => {
  it("hammer / shooting star / rejection wick", () => {
    expect(hammerLike(b(10, 10.2, 8, 10.1))).toBe(true);
    expect(hammerLike(b(10, 11, 8, 10.1))).toBe(false);
    expect(shootingStarLike(b(10, 12, 9.9, 9.9))).toBe(true);
    expect(shootingStarLike(b(10, 10, 10, 10))).toBe(false);
    expect(rejectionWick(b(10, 10.5, 8, 10.2))).toEqual({ bullish: true, bearish: false });
    expect(rejectionWick(b(10, 12.5, 9.8, 10))).toEqual({ bullish: false, bearish: true });
  });
  it("morning star / evening star", () => {
    expect(morningStarLike(b(110, 110.5, 99.5, 100), b(100, 101, 99, 100.5), b(100.5, 107, 100, 106))).toBe(true);
    expect(morningStarLike(b(110, 110.5, 99.5, 100), b(100, 101, 99, 100.5), b(100.5, 104, 100, 103))).toBe(false); // below midpoint
    expect(eveningStarLike(b(100, 110.5, 99.5, 110), b(110, 111, 109, 109.5), b(109.5, 110, 103, 104))).toBe(true);
    expect(eveningStarLike(b(100, 110.5, 99.5, 110), b(110, 117, 109, 115), b(115, 116, 103, 104))).toBe(false); // middle body too big
  });
  it("readPatterns reads only the latest CLOSED bar and its two predecessors", () => {
    const bars = [b(110, 110.5, 99.5, 100, 0), b(100, 101, 99, 100.5, 1), b(100.5, 107, 100, 106, 2)];
    expect(readPatterns(bars, "M15").bullish).toContain("MORNING_STAR_LIKE");
    expect(readPatterns([], "M5").direction).toBe("INSUFFICIENT");
  });
});

describe("operator v2 — causality & safety", () => {
  it("no lookahead: structure events and zones use only swings confirmed inside the input", () => {
    const H1 = series("H1", up(60));
    const prefix = H1.slice(0, 40);
    const a = operatorAnalysis({ M5: series("M5", up(40)), M15: series("M15", up(60)), H1: prefix, H4: series("H4", up(60)) }, 110);
    const lastAvail = prefix[prefix.length - 1]!.available_at;
    for (const z of a.zones.H1 ?? []) expect(z.latest_touch_at).toBeLessThanOrEqual(lastAvail);
    for (const s of structureOf(prefix).swings) expect(structureOf(H1).swings).toContainEqual(s);
  });
  it("MONITOR_ONLY / no order path unchanged", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    const src = readFileSync("src/core/technical/operator.ts", "utf8");
    expect(src).not.toMatch(/order_send|fetch\(|WebSocket\(|placeOrder|submitOrder/);
  });
});

import { operatorSummary } from "@/components/TechnicalSlicePanel";
describe("operator v2 — cockpit trader-language summary", () => {
  it("maps operator evidence to MODE/H4/H1/AREA/EMA/TRIGGER/STATUS without deriving signals", () => {
    expect(operatorSummary(null)).toMatchObject({ mode: "TIDAK JELAS", status: "HOLD", trigger: "belum ada" });
    const H1 = series("H1", down(60));
    const price = (ema(H1, 21) as { value: number }).value;
    const s = evaluate(input({ M5: series("M5", down(40)), M15: series("M15", down(60)), H1, H4: series("H4", down(60)) }, price));
    expect(operatorSummary(s)).toMatchObject({ mode: "TREND", h4: "TURUN", h1: "SEARAH", status: "CARI SELL" });
  });
});
