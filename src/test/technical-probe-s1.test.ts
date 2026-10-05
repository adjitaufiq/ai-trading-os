import { describe, expect, it } from "vitest";
import { TIMEFRAME_MS } from "@/core/contracts";
import { auditLookahead, causalSwings, retrospectiveSwings } from "@/probe/technical/swing";
import type { ProbeBar } from "@/probe/technical/types";

const T0 = Date.UTC(2026, 0, 5);
const mk = (rows: [number, number][]): ProbeBar[] => rows.map(([h, l], i) => {
  const s = TIMEFRAME_MS.M5, o = T0 + i * s;
  return { symbol: "XAUUSD", timeframe: "M5", origin: "FIXTURE", open_time: o, close_time: o + s, lifecycle: "CLOSED",
    closed_at: o + s, available_at: o + s, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2 };
});
// bar 2 is an outside bar: strictly highest high AND strictly lowest low in the 2+2 window
const outside = mk([[10, 8], [11, 9], [20, 1], [11, 9], [10, 8]]);

describe("S1 outside bar preserves both facts", () => {
  it("retrospective emits SWING_HIGH and SWING_LOW for the same bar", () => {
    const r = retrospectiveSwings(outside, "M5");
    expect(r.map((s) => s.type).sort()).toEqual(["SWING_HIGH", "SWING_LOW"]);
    expect(r.every((s) => s.outside_bar && s.event_at === outside[2]!.open_time)).toBe(true);
  });
  it("causal emits both, available only at the actual confirming CLOSED bar", () => {
    const c = causalSwings(outside, "M5").swings;
    expect(c.map((s) => s.type).sort()).toEqual(["SWING_HIGH", "SWING_LOW"]);
    expect(c.every((s) => s.available_at === outside[4]!.available_at && s.trading_authority === "NONE")).toBe(true);
    expect(causalSwings(outside.slice(0, 4), "M5").swings).toHaveLength(0);
  });
  it("deterministic and no direction semantics", () => {
    expect(JSON.stringify(causalSwings(outside, "M5"))).toBe(JSON.stringify(causalSwings(outside, "M5")));
    expect(JSON.stringify(causalSwings(outside, "M5"))).not.toMatch(/BUY|SELL/);
  });
  it("lookahead audit covers both labels", () => {
    expect(auditLookahead(outside, "M5").items).toHaveLength(2);
  });
  it("non-outside bar unaffected", () => {
    const r = retrospectiveSwings(mk([[10, 8], [11, 9], [20, 10], [11, 9], [10, 8]]), "M5");
    expect(r.map((s) => [s.type, s.outside_bar])).toEqual([["SWING_HIGH", false]]);
  });
});
