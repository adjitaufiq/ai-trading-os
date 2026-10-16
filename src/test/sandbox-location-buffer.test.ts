// SANDBOX ONLY — hypothesis test: LOCATION_BROKEN with a 0.15 × M15 ATR buffer.
// Production signalLifecycle.ts is NOT modified; the variant only wraps updateSetup by presenting a
// closed bar whose penetration is within the buffer as touching keyLevel. Every other rule (structure,
// EMA, anti-chase, TTL, promotion, SL/TP, RR, Gate, Risk) runs through the unchanged production code.
// No orders, no paper orders, no runtime/VPS change. Not evidence of edge or production readiness.
import { describe, expect, it } from "vitest";
import { evaluateSetup } from "@/engine/signal/signalEvaluator";
import { createSetup, updateSetup, type UpdateInput } from "@/engine/signal/signalLifecycle";
import type { SignalSetup } from "@/engine/signal/types";
import type { ArenaCandle } from "@/engine/core/normalizer/types";
import { T0, bias, ema, input, loc, m5, reaction } from "@/engine/signal/tests/helpers";

export const SANDBOX_LOCATION_BUFFER_ATR = 0.15;

/** BUY: broken only if close < keyLevel − 0.15·ATR; SELL: close > keyLevel + 0.15·ATR. Invalid ATR ⇒ buffer 0. */
export function sandboxUpdateSetup(s: SignalSetup, u: UpdateInput) {
  const buf = Number.isFinite(u.m15Atr) && u.m15Atr > 0 ? u.m15Atr * SANDBOX_LOCATION_BUFFER_ATR : 0;
  const buy = s.direction === "BUY";
  const soften = (c?: ArenaCandle): ArenaCandle | undefined => {
    if (!c || !c.isClosed) return c; // forming bars untouched (production ignores them)
    const pen = buy ? s.keyLevel - c.close : c.close - s.keyLevel;
    return pen > 0 && pen <= buf ? { ...c, close: s.keyLevel } : c;
  };
  const m15 = soften(u.m15);
  return updateSetup(s, { ...u, m5: soften(u.m5)!, ...(m15 ? { m15 } : {}) });
}

function bornBuy(p = {}): SignalSetup {
  const i = input(p);
  const r = createSetup(evaluateSetup(i), i, i.reaction!, m5(0, 2651), 2651);
  if (!r) throw new Error("not created");
  return r.setup;
}
const bornSell = () => {
  const i = input({ bias: bias("BEARISH"), priceContext: loc("AT_RESISTANCE"), emaContext: ema([]), reaction: reaction("BEARISH") });
  const r = createSetup(evaluateSetup(i), i, i.reaction!, m5(0, 2651), 2651);
  if (!r) throw new Error("not created");
  return r.setup;
};
const U = (p: Partial<UpdateInput> = {}): UpdateInput => ({ m5: m5(1, 2652), price: 2652, m15Atr: 4, m15StructureShift: "NONE", emaContext: ema([]), now: T0 + 600, ...p });

describe("sandbox LOCATION_BROKEN buffer (synthetic)", () => {
  // ATR 4 ⇒ buffer 0.6. BUY keyLevel 2650.5.
  it("baseline unchanged: production breaks on 2650.3 (0.2 below key)", () => {
    const s = bornBuy();
    expect(updateSetup(s, U({ m5: m5(1, 2650.3), price: 2650.3 })).setup.invalidationReason).toBe("LOCATION_BROKEN");
  });
  it("variant: BUY penetration within buffer survives location check", () => {
    const s = bornBuy();
    expect(sandboxUpdateSetup(s, U({ m5: m5(1, 2650.3), price: 2650.3 })).setup.state).toBe("READY");
  });
  it("variant: BUY penetration beyond buffer still LOCATION_BROKEN", () => {
    expect(sandboxUpdateSetup(bornBuy(), U({ m5: m5(1, 2649.8), price: 2649.8 })).setup.invalidationReason).toBe("LOCATION_BROKEN");
  });
  it("SELL symmetric: within buffer survives, beyond buffer breaks, baseline breaks", () => {
    const s = bornSell(); const k = s.keyLevel;
    expect(updateSetup(s, U({ m5: m5(1, k + 0.3), price: 2651 })).setup.invalidationReason).toBe("LOCATION_BROKEN");
    expect(sandboxUpdateSetup(s, U({ m5: m5(1, k + 0.3), price: 2651 })).setup.invalidationReason).not.toBe("LOCATION_BROKEN");
    expect(sandboxUpdateSetup(s, U({ m5: m5(1, k + 0.7), price: 2651 })).setup.invalidationReason).toBe("LOCATION_BROKEN");
  });
  it("forming candle is ignored identically by both", () => {
    const s = bornBuy(); const u = U({ m5: m5(1, 2640, false) });
    expect(sandboxUpdateSetup(s, u).setup).toBe(updateSetup(s, u).setup);
  });
  it("invalid ATR ⇒ buffer 0 ⇒ identical to baseline", () => {
    const s = bornBuy(); const u = U({ m5: m5(1, 2650.3), m15Atr: NaN });
    expect(sandboxUpdateSetup(s, u).setup.invalidationReason).toBe(updateSetup(s, u).setup.invalidationReason);
  });
  it("other filters unchanged: EMA, structure, TTL, chase still fire", () => {
    const s = bornBuy(); const near = m5(1, 2650.3);
    expect(sandboxUpdateSetup(s, U({ m5: near, emaContext: ema(["EMA21_REJECT_DOWN"]) })).setup.invalidationReason).toBe("EMA_CONTEXT_FAILED");
    expect(sandboxUpdateSetup(s, U({ m5: near, m15StructureShift: "BEARISH_MSS" })).setup.invalidationReason).toBe("STRUCTURE_SHIFT");
    expect(sandboxUpdateSetup(s, U({ m5: m5(3, 2650.3) })).setup).toMatchObject({ state: "EXPIRED", expiredBy: "TTL" });
    expect(sandboxUpdateSetup(s, U({ m5: near, price: 2653.5 })).setup).toMatchObject({ expiredBy: "PRICE_CHASED" });
  });
  it("no lookahead: only the supplied closed bar is read; outcome equal to baseline when no penetration", () => {
    const s = bornBuy();
    for (const c of [2651, 2652, 2650.5]) {
      const u = U({ m5: m5(1, c), price: c });
      expect(sandboxUpdateSetup(s, u).setup).toEqual(updateSetup(s, u).setup);
    }
  });
  it("output carries no order fields", () => {
    const r = sandboxUpdateSetup(bornBuy(), U({ m5: m5(1, 2650.3) })).setup as unknown as Record<string, unknown>;
    for (const k of ["sl", "tp", "lot", "volume", "order", "ticket"]) expect(r[k]).toBeUndefined();
  });
});
