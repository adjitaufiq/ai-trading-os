import { describe, expect, it } from "vitest";
import { markSymbol, openSignals, type LabState } from "@/core/lab/labLedger";

const empty: LabState = { trades: [], seen: {}, started_at: null };
const sig = (strategy: string) => ({ strategy, side: "BUY", why: "t", bar_time: 1, sl_distance: 1 }) as never;

describe("Copet v2", () => {
  it("XAU: SL/TP $10 (5.00 price)", () => {
    const s = openSignals(empty, "XAUUSD", [sig("EMA_CROSS")], { bid: 2000, ask: 2000 }, 0, "COPET");
    expect(s.trades[0]!.sl).toBeCloseTo(1995);
    expect(s.trades[0]!.tp).toBeCloseTo(2005);
  });
  it("BTC: SL/TP $20 (400 price)", () => {
    const s = openSignals(empty, "BTCUSD", [sig("EMA_CROSS")], { bid: 80000, ask: 80000 }, 0, "COPET");
    expect(s.trades[0]!.sl).toBeCloseTo(79600);
    expect(s.trades[0]!.tp).toBeCloseTo(80400);
  });
  it("BTC trailing arms at +$6 and locks peak − $4", () => {
    let s = openSignals(empty, "BTCUSD", [sig("EMA_CROSS")], { bid: 80000, ask: 80000 }, 0, "COPET");
    s = markSymbol(s, "BTCUSD", { bid: 80100, ask: 80100 }, 1); // +$5, not armed
    expect(s.trades[0]!.trail_floor_usd).toBeNull();
    s = markSymbol(s, "BTCUSD", { bid: 80200, ask: 80200 }, 2); // +$10 peak ⇒ floor $6
    expect(s.trades[0]!.trail_floor_usd).toBeCloseTo(6);
    s = markSymbol(s, "BTCUSD", { bid: 80115, ask: 80115 }, 3); // +$5.75 ⇒ TRAIL
    expect(s.trades[0]!.exit_reason).toBe("TRAIL");
  });
  it("XAU trailing arms at +$3 and locks peak − $2", () => {
    let s = openSignals(empty, "XAUUSD", [sig("EMA_CROSS")], { bid: 2000, ask: 2000 }, 0, "COPET");
    s = markSymbol(s, "XAUUSD", { bid: 2001.25, ask: 2001.25 }, 1); // +$2.5
    expect(s.trades[0]!.trail_floor_usd).toBeNull();
    s = markSymbol(s, "XAUUSD", { bid: 2003, ask: 2003 }, 2); // +$6 ⇒ floor $4
    expect(s.trades[0]!.trail_floor_usd).toBeCloseTo(4);
  });
});
