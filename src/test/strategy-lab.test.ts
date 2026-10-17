import { describe, expect, it } from "vitest";
import { emptyLab, leaderboard, markSymbol, openSignals, LAB_START_BALANCE } from "@/core/lab/labLedger";
import type { LabSignal } from "@/core/lab/strategies";

const sig = (strategy: LabSignal["strategy"], side: LabSignal["side"], bar = 1): LabSignal => ({ strategy, side, why: "t", sl_distance: 2, bar_time: bar });
const q = { bid: 100, ask: 100 };

describe("strategy lab ledger", () => {
  it("starts at $500", () => { expect(leaderboard(emptyLab()).balance).toBe(500); expect(LAB_START_BALANCE).toBe(500); });
  it("has no position cap across modes and symbols", () => {
    let s = emptyLab();
    s = openSignals(s, "XAUUSD", [sig("TOUCH_SNR", "BUY"), sig("EMA_CROSS", "BUY"), sig("SNR_PA", "SELL"), sig("DUAL_WALL", "BUY"), sig("FAST_BREAKOUT", "SELL")], q, 1);
    s = openSignals(s, "BTCUSD", [sig("TOUCH_SNR", "BUY"), sig("EMA_CROSS", "SELL")], q, 1);
    expect(s.trades.filter((t) => t.status === "OPEN").length).toBe(7);
  });
  it("opens a signal bar only once per mode", () => {
    let s = openSignals(emptyLab(), "XAUUSD", [sig("TOUCH_SNR", "BUY")], q, 1);
    s = openSignals(s, "XAUUSD", [sig("TOUCH_SNR", "BUY")], q, 2);
    expect(s.trades.length).toBe(1);
  });
  it("XAU 0.02 lot TP at 1.5R pays $6 and is credited to its mode", () => {
    let s = openSignals(emptyLab(), "XAUUSD", [sig("SNR_PA", "BUY")], q, 1);
    s = markSymbol(s, "XAUUSD", { bid: 103, ask: 103 }, 2);
    const t = s.trades[0]!;
    expect(t.exit_reason).toBe("TP");
    expect(t.pnl_usd).toBeCloseTo(6);
    const row = leaderboard(s).rows.find((r) => r.strategy === "SNR_PA")!;
    expect(row.wins).toBe(1);
    expect(leaderboard(s).balance).toBeCloseTo(506);
  });
  it("SL closes with loss", () => {
    let s = openSignals(emptyLab(), "XAUUSD", [sig("EMA_CROSS", "SELL")], q, 1);
    s = markSymbol(s, "XAUUSD", { bid: 102, ask: 102 }, 2);
    expect(s.trades[0]!.exit_reason).toBe("SL");
    expect(s.trades[0]!.pnl_usd).toBeCloseTo(-4);
  });
});

describe("mode copet", () => {
  // BTC 0.05 lot ⇒ $0.05 per point; $5 = 100 pts.
  const open = () => openSignals(emptyLab(), "BTCUSD", [sig("TOUCH_SNR", "BUY")], { bid: 1000, ask: 1000 }, 1, "COPET");
  it("TP +$5 and SL -$5 (1:1)", () => {
    const t = open().trades[0]!;
    expect(t.tp).toBeCloseTo(1100); expect(t.sl).toBeCloseTo(900);
    expect(markSymbol(open(), "BTCUSD", { bid: 1100, ask: 1100 }, 2).trades[0]!.pnl_usd).toBeCloseTo(5);
    expect(markSymbol(open(), "BTCUSD", { bid: 900, ask: 900 }, 2).trades[0]!.pnl_usd).toBeCloseTo(-5);
  });
  it("peak +$2 then back to +$1 closes TRAIL +$1", () => {
    let s = markSymbol(open(), "BTCUSD", { bid: 1040, ask: 1040 }, 2);
    expect(s.trades[0]!.status).toBe("OPEN");
    s = markSymbol(s, "BTCUSD", { bid: 1020, ask: 1020 }, 3);
    expect(s.trades[0]!.exit_reason).toBe("TRAIL"); expect(s.trades[0]!.pnl_usd).toBeCloseTo(1);
  });
  it("peak +$4 then +$3 closes TRAIL +$3", () => {
    let s = markSymbol(open(), "BTCUSD", { bid: 1080, ask: 1080 }, 2);
    s = markSymbol(s, "BTCUSD", { bid: 1060, ask: 1060 }, 3);
    expect(s.trades[0]!.exit_reason).toBe("TRAIL"); expect(s.trades[0]!.pnl_usd).toBeCloseTo(3);
  });
  it("below +$2 peak no trailing", () => {
    let s = markSymbol(open(), "BTCUSD", { bid: 1030, ask: 1030 }, 2);
    s = markSymbol(s, "BTCUSD", { bid: 1000, ask: 1000 }, 3);
    expect(s.trades[0]!.status).toBe("OPEN");
  });
});
