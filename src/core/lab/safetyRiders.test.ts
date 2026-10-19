import { describe, expect, it } from "vitest";
import { applySafetyRiders, breathLeftMs, cooldownLeftMs } from "./safetyRiders";
import type { LabState } from "./labLedger";

const st = (trades: unknown[]) => ({ trades } as unknown as LabState);
const flat = (n: number) => Array.from({ length: n }, () => ({ open: 100, high: 101, low: 99, close: 100.5 }));
const sig = [{ side: "BUY" as const }, { side: "SELL" as const }];

describe("safety riders", () => {
  it("blocks a market for 15 minutes after an SL, other market free", () => {
    const s = st([{ symbol: "BTCUSD", exit_reason: "SL", closed_at: 1_000_000 }]);
    expect(cooldownLeftMs(s, "BTCUSD", 1_000_000 + 14 * 60_000)).toBe(60_000);
    expect(cooldownLeftMs(s, "BTCUSD", 1_000_000 + 15 * 60_000)).toBe(0);
    expect(cooldownLeftMs(s, "XAUUSD", 1_000_000)).toBe(0);
    expect(applySafetyRiders(sig, s, "BTCUSD", flat(20), 1_000_000 + 60_000).blocked).toBe("BLOCK_POST_SL_COOLDOWN");
  });
  it("TP exits do not start a cooldown", () => {
    expect(cooldownLeftMs(st([{ symbol: "BTCUSD", exit_reason: "TP", closed_at: 1 }]), "BTCUSD", 2)).toBe(0);
  });
  it("blocks all entries when last candle range > 1.8×ATR", () => {
    const bars = [...flat(20), { open: 100, high: 104, low: 99.5, close: 103.5 }]; // range 4.5 > 1.8×2
    expect(applySafetyRiders(sig, st([]), "XAUUSD", bars, 0)).toEqual({ pass: [], blocked: "BLOCK_SPIKE_VOLATILITY" });
  });
  it("upper wick ≥ 60% blocks BUY only; lower wick blocks SELL only", () => {
    const up = applySafetyRiders(sig, st([]), "XAUUSD", [...flat(20), { open: 100, high: 102, low: 99.8, close: 100.2 }], 0);
    expect(up.pass.map((x) => x.side)).toEqual(["SELL"]);
    const dn = applySafetyRiders(sig, st([]), "XAUUSD", [...flat(20), { open: 100.2, high: 100.4, low: 98.2, close: 100 }], 0);
    expect(dn.pass.map((x) => x.side)).toEqual(["BUY"]);
  });
  it("normal candle passes everything", () => {
    expect(applySafetyRiders(sig, st([]), "XAUUSD", flat(21), 0)).toEqual({ pass: sig, blocked: null });
  });
});

describe("post-exit breath per mode+market", () => {
  const T0 = 10_000_000;
  const s = st([
    { symbol: "XAUUSD", strategy: "A", exit_reason: "TP", closed_at: T0 },
    { symbol: "XAUUSD", strategy: "B", exit_reason: "TRAIL", closed_at: T0 },
    { symbol: "XAUUSD", strategy: "C", exit_reason: "MANUAL", closed_at: T0 },
  ]);
  it("TP rests 5 minutes, TRAIL and other exits 10 minutes", () => {
    expect(breathLeftMs(s, "A", "XAUUSD", T0 + 4 * 60_000)).toBe(60_000);
    expect(breathLeftMs(s, "A", "XAUUSD", T0 + 5 * 60_000)).toBe(0);
    expect(breathLeftMs(s, "B", "XAUUSD", T0 + 9 * 60_000)).toBe(60_000);
    expect(breathLeftMs(s, "C", "XAUUSD", T0 + 10 * 60_000)).toBe(0);
  });
  it("only the resting mode on that market is blocked", () => {
    expect(breathLeftMs(s, "A", "BTCUSD", T0)).toBe(0);
    const r = applySafetyRiders([{ side: "BUY" as const, strategy: "A" }, { side: "BUY" as const, strategy: "Z" }], s, "XAUUSD", flat(20), T0 + 60_000);
    expect(r.pass.map((x) => x.strategy)).toEqual(["Z"]);
    expect(r.blocked).toBe("BLOCK_POST_EXIT_BREATH");
  });
});
