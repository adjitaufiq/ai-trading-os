import { describe, expect, it } from "vitest";
import { marketBreakdown } from "./labReport";

describe("marketBreakdown", () => {
  const rows = [
    { strategy: "DUAL_WALL_FAST", symbol: "XAUUSD", pnl_usd: 5, closed_at_ms: 200 },
    { strategy: "DUAL_WALL_FAST", symbol: "XAUUSD", pnl_usd: -2, closed_at_ms: 210 },
    { strategy: "SMC_FIBO_OTE", symbol: "BTCUSD", pnl_usd: -6, closed_at_ms: 220 },
    { strategy: "EMA_CROSS", symbol: "BTCUSD", pnl_usd: 4, closed_at_ms: 50 },
    { strategy: "EMA_CROSS", symbol: "BTCUSD", pnl_usd: 9, closed_at_ms: null },
  ];
  it("counts only trades closed since the day start, per market", () => {
    const [xau, btc] = marketBreakdown(rows, 100);
    expect(xau).toMatchObject({ symbol: "XAUUSD", n: 2, w: 1, pnl: 3, gross: 5, loss: -2 });
    expect(btc).toMatchObject({ symbol: "BTCUSD", n: 1, w: 0, pnl: -6 });
    expect(btc!.modes[0]).toMatchObject({ strategy: "SMC_FIBO_OTE", pnl: -6 });
  });
});
