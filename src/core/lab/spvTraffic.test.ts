import { describe, expect, it } from "vitest";
import { applySpv } from "./spvTraffic";
import { emptyLab } from "./labLedger";

const T = 1_800_000_000_000;
const sig = (strategy: string, side: "BUY" | "SELL", bar_time = T) => ({ strategy, side, bar_time });

describe("SPV traffic", () => {
  it("opposite sides on the same M5 candle: priority mode wins, other vetoed", () => {
    const r = applySpv([sig("EMA_CROSS", "SELL"), sig("DUAL_WALL_FAST", "BUY")], emptyLab(), "XAUUSD", T + 5 * 60_000);
    expect(r.pass.map((x) => x.strategy)).toEqual(["DUAL_WALL_FAST"]);
    expect(r.blocked).toBe("BLOCK_SPV_DIRECTION_LOCK");
  });
  it("stale signals older than 10 minutes are dropped", () => {
    const r = applySpv([sig("EMA_CROSS", "BUY")], emptyLab(), "XAUUSD", T + 11 * 60_000);
    expect(r.pass).toEqual([]);
    expect(r.blocked).toBe("BLOCK_SPV_STALE_SIGNAL");
  });
  it("same-side signals pass ordered by priority", () => {
    const r = applySpv([sig("EMA_CROSS", "BUY"), sig("SMC_FIBO_OTE", "BUY")], emptyLab(), "BTCUSD", T + 60_000);
    expect(r.pass.map((x) => x.strategy)).toEqual(["SMC_FIBO_OTE", "EMA_CROSS"]);
    expect(r.blocked).toBeNull();
  });
});

import { buildSpvQueue, dropRejected, spvKey } from "./spvTraffic";
describe("SPV queue + operator reject", () => {
  const a = { side: "BUY" as const, strategy: "DUAL_WALL_FAST", bar_time: 1 };
  const b = { side: "SELL" as const, strategy: "EMA_CROSS", bar_time: 1 };
  const c = { side: "BUY" as const, strategy: "FAST_BREAKOUT", bar_time: 1 };
  it("queues locked and slot-full signals, not opened ones", () => {
    const q = buildSpvQueue("XAUUSD", [a, b, c], [a, c], [a], 0);
    expect(q.map((x) => [x.strategy, x.reason])).toEqual([["EMA_CROSS", "DIRECTION_LOCK"], ["FAST_BREAKOUT", "SLOT_FULL"]]);
  });
  it("rejected signal never re-enters", () => {
    expect(dropRejected("XAUUSD", [a, c], new Set([spvKey("XAUUSD", c)]))).toEqual([a]);
  });
});
