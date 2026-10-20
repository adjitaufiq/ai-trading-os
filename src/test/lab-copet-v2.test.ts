import { describe, expect, it } from "vitest";
import { copetParams, markSymbol, openSignals, type LabState } from "@/core/lab/labLedger";
import { LAB_RISK_POLICY_FILE_CONTENT as P } from "@/core/lab/demo/labRiskPolicy";

const empty: LabState = { trades: [], seen: {}, started_at: null };
const sig = (strategy: string) => ({ strategy, side: "BUY", why: "t", bar_time: 1, sl_distance: 1 }) as never;

describe("Copet v2 (arm +$2, gap $1, SL/TP $10)", () => {
  it("XAU: SL/TP $10 (5.00 price)", () => {
    const s = openSignals(empty, "XAUUSD", [sig("EMA_CROSS")], { bid: 2000, ask: 2000 }, 0, "COPET");
    expect(s.trades[0]!.sl).toBeCloseTo(1995);
    expect(s.trades[0]!.tp).toBeCloseTo(2005);
  });
  it("BTC: SL/TP $10 (200 price)", () => {
    const s = openSignals(empty, "BTCUSD", [sig("EMA_CROSS")], { bid: 80000, ask: 80000 }, 0, "COPET");
    expect(s.trades[0]!.sl).toBeCloseTo(79800);
    expect(s.trades[0]!.tp).toBeCloseTo(80200);
  });
  it("XAU: +$1.99 not armed, +$2 locks +$1, peak $7 → floor $6, floor never drops, touch ⇒ TRAIL", () => {
    let s = openSignals(empty, "XAUUSD", [sig("EMA_CROSS")], { bid: 2000, ask: 2000 }, 0, "COPET");
    s = markSymbol(s, "XAUUSD", { bid: 2000.995, ask: 2000.995 }, 1); // +$1.99
    expect(s.trades[0]!.trail_floor_usd).toBeNull();
    s = markSymbol(s, "XAUUSD", { bid: 2001, ask: 2001 }, 2); // +$2
    expect(s.trades[0]!.trail_floor_usd).toBeCloseTo(1);
    s = markSymbol(s, "XAUUSD", { bid: 2003.5, ask: 2003.5 }, 3); // +$7
    expect(s.trades[0]!.trail_floor_usd).toBeCloseTo(6);
    s = markSymbol(s, "XAUUSD", { bid: 2003.25, ask: 2003.25 }, 4); // +$6.5, floor stays 6
    expect(s.trades[0]!.status).toBe("OPEN");
    expect(s.trades[0]!.trail_floor_usd).toBeCloseTo(6);
    s = markSymbol(s, "XAUUSD", { bid: 2003, ask: 2003 }, 5); // +$6 touches floor
    expect(s.trades[0]!.exit_reason).toBe("TRAIL");
  });
  it("BTC: +$1.99 not armed, +$2 locks +$1, peak $7 → floor $6", () => {
    let s = openSignals(empty, "BTCUSD", [sig("EMA_CROSS")], { bid: 80000, ask: 80000 }, 0, "COPET");
    s = markSymbol(s, "BTCUSD", { bid: 80039.8, ask: 80039.8 }, 1);
    expect(s.trades[0]!.trail_floor_usd).toBeNull();
    s = markSymbol(s, "BTCUSD", { bid: 80040, ask: 80040 }, 2);
    expect(s.trades[0]!.trail_floor_usd).toBeCloseTo(1);
    s = markSymbol(s, "BTCUSD", { bid: 80140, ask: 80140 }, 3);
    expect(s.trades[0]!.trail_floor_usd).toBeCloseTo(6);
  });
  it("PAPER and DEMO policy agree on arm/gap/SL/TP", () => {
    for (const sym of ["XAUUSD", "BTCUSD"] as const) {
      const c = copetParams(sym), d = (P as any).copet[sym];
      expect([c.TRAIL_ARM_USD, c.TRAIL_GAP_USD, c.SL_USD, c.TP_USD]).toEqual([2, 1, 10, 10]);
      expect([d.trail_arm_usd, d.trail_gap_usd, d.sl_usd, d.tp_usd]).toEqual([2, 1, 10, 10]);
    }
  });
});
