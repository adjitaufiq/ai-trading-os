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
  // COPET v2 BTC: 0.05 lot ⇒ $0.05 per point; SL/TP $20 = 400 pts, arm +$6, gap $4.
  const open = () => openSignals(emptyLab(), "BTCUSD", [sig("TOUCH_SNR", "BUY")], { bid: 1000, ask: 1000 }, 1, "COPET");
  it("TP +$20 and SL -$20 (1:1)", () => {
    const t = open().trades[0]!;
    expect(t.tp).toBeCloseTo(1400); expect(t.sl).toBeCloseTo(600);
    expect(markSymbol(open(), "BTCUSD", { bid: 1400, ask: 1400 }, 2).trades[0]!.pnl_usd).toBeCloseTo(20);
    expect(markSymbol(open(), "BTCUSD", { bid: 600, ask: 600 }, 2).trades[0]!.pnl_usd).toBeCloseTo(-20);
  });
  it("peak +$8 then back to +$4 closes TRAIL +$4", () => {
    let s = markSymbol(open(), "BTCUSD", { bid: 1160, ask: 1160 }, 2);
    expect(s.trades[0]!.status).toBe("OPEN");
    s = markSymbol(s, "BTCUSD", { bid: 1080, ask: 1080 }, 3);
    expect(s.trades[0]!.exit_reason).toBe("TRAIL"); expect(s.trades[0]!.pnl_usd).toBeCloseTo(4);
  });
  it("peak +$10 then +$6 closes TRAIL +$6", () => {
    let s = markSymbol(open(), "BTCUSD", { bid: 1200, ask: 1200 }, 2);
    s = markSymbol(s, "BTCUSD", { bid: 1120, ask: 1120 }, 3);
    expect(s.trades[0]!.exit_reason).toBe("TRAIL"); expect(s.trades[0]!.pnl_usd).toBeCloseTo(6);
  });
  it("below +$6 peak no trailing", () => {
    let s = markSymbol(open(), "BTCUSD", { bid: 1100, ask: 1100 }, 2);
    s = markSymbol(s, "BTCUSD", { bid: 1000, ask: 1000 }, 3);
    expect(s.trades[0]!.status).toBe("OPEN");
  });
});
