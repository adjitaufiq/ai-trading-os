import { describe, expect, it } from "vitest";
import { emptyLab, markSymbol, openSignals } from "@/core/lab/labLedger";
import { defaultSwitches } from "@/core/lab/modeSwitch";
import { DEFAULT_OPERATOR } from "@/core/lab/operatorControl";
import type { LabSignal } from "@/core/lab/strategies";

const sig: LabSignal = { strategy: "SMC_FIBO_OTE", side: "BUY", why: "t", sl_distance: 10, tp_distance: 30, bar_time: 1 };
const q = (p: number) => ({ bid: p, ask: p });

describe("Mode 12 SMC Fibo", () => {
  it("is ON by default with 1 slot on XAU and BTC", () => {
    expect(defaultSwitches().SMC_FIBO_OTE).toBe(true);
    expect(DEFAULT_OPERATOR.marketQuota.SMC_FIBO_OTE).toEqual({ XAUUSD: 1, BTCUSD: 1 });
  });
  it("uses technical SL/TP even in the Copet journal", () => {
    const t = openSignals(emptyLab(), "XAUUSD", [sig], q(2000), 0, "COPET").trades[0]!;
    expect(t.sl).toBe(1990); expect(t.tp).toBe(2030); expect(t.exit_profile).toBe("FIBO");
  });
  it("trails after +1R with a gap of 0.5R", () => {
    // XAU 0.02 lot × 100 ⇒ $2/point; R = 10 points = $20; gap = $10
    let s = openSignals(emptyLab(), "XAUUSD", [sig], q(2000), 0, "COPET");
    s = markSymbol(s, "XAUUSD", q(2008), 1);
    expect(s.trades[0]!.trail_floor_usd).toBeNull();
    s = markSymbol(s, "XAUUSD", q(2015), 2); // peak $30 ⇒ floor $20
    expect(s.trades[0]!.trail_floor_usd).toBe(20);
    s = markSymbol(s, "XAUUSD", q(2010), 3); // $20 ⇒ trailed out
    expect(s.trades[0]!.exit_reason).toBe("TRAIL");
    expect(s.trades[0]!.pnl_usd).toBe(20);
  });
});
