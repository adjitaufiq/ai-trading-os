// Signal Lifecycle Hardening V1 acceptance tests (same stub rig as journal-lifecycle.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar, Timeframe } from "@/core/contracts";
import { ActiveSignalRegistry, regimeLabel, validateSignalContext } from "@/core/paper/signalHardening";

const h = vi.hoisted(() => ({ ev: null as unknown, created: 0, planned: false, expiry: undefined as number | undefined, terminal: false, promote: false }));
vi.mock("@/engine/core/location/priceLocationEngine", () => ({
  classifyPriceLocation: () => ({ ok: true, context: { priceLocation: "AT_SUPPORT", locationTier: "T1", keyLevelPrice: 1999 } }),
  computeAtr: () => 3,
}));
vi.mock("@/engine/core/ema/emaStateEngine", () => ({ computeEMAContext: () => ({ ok: true, context: { actions: [], pricePosition: "ABOVE_ALL" } }) }));
vi.mock("@/engine/core/reaction/reactionEvaluator", () => ({ evaluateReaction: () => ({ ok: true, result: { pattern: "ENGULFING", quality: "STRONG" } }) }));
vi.mock("@/engine/signal/signalEvaluator", () => ({ evaluateSetup: () => h.ev }));
vi.mock("@/engine/signal/signalLifecycle", () => ({
  createSetup: (ev: { direction: "BUY" | "SELL"; state: string }) => { h.created++; return { setup: { id: `s${h.created}`, symbol: "XAUUSD", direction: ev.direction, state: ev.state, triggerPattern: "ENGULFING", keyLevel: 1999, expiryTimestamp: h.expiry } }; },
  updateSetup: (s: { state: string }) => ({ setup: h.terminal ? { ...s, state: "INVALIDATED" } : h.promote ? { ...s, state: "READY" } : s }),
  isTerminal: (s: { state: string }) => s.state === "INVALIDATED" || s.state === "EXPIRED",
}));
vi.mock("@/engine/plan/tradePlanEngine", () => ({ buildTradePlan: () => ({ status: "HOLD", holdReason: "TEST_STOP_AT_PLAN" }) }));
vi.mock("@/engine/risk/riskEngine", () => ({ evaluateRisk: () => ({ decision: "APPROVED", reasons: [] }) }));

const { LivePaperLoop } = await import("@/core/paper/LivePaperLoop");
const spec = Object.freeze({ symbol: "XAUUSD", origin: "BROKER_REPORTED" as const, digits: 3, point: 0.001, tick_size: 0.001, contract_size: 100, broker_utc_offset_ms: 0 });
const M5 = 300_000, T0 = 1_700_000_000_000;
const bar = (tf: Timeframe, i: number, ms: number): Bar => ({ symbol: "XAUUSD", timeframe: tf, status: "CLOSED", open_time: T0 + i * ms, close_time: T0 + (i + 1) * ms, available_at: T0 + (i + 1) * ms, open: 2000, high: 2001, low: 1999, close: 2000, tick_count: 1 } as unknown as Bar);
const hist = (tf: Timeframe, n: number, ms: number) => Array.from({ length: n }, (_, i) => bar(tf, i, ms));

function rig(o: { pbAsOf?: () => number | null; m15Shift?: number } = {}) {
  let k = 0;
  const provider = () => { const a = o.pbAsOf ? o.pbAsOf() : T0; return a === null ? null : { bias: "BUY" as const, asOf: a, source: "TECHNICAL_H4_CLOSED" as const, arenaStatus: "CARI_BUY" }; };
  const loop = new LivePaperLoop("XAUUSD", "REAL_MT5", spec, provider);
  const closed = (tf: Timeframe) => tf === "M5" ? hist("M5", 20 + k, M5) : tf === "M15" ? hist("M15", 20, 3 * M5).map((b) => ({ ...b, open_time: b.open_time - (o.m15Shift ?? 20 * 3 * M5), close_time: b.close_time - (o.m15Shift ?? 20 * 3 * M5) })) : [];
  const step = () => { k++; loop.onClosedM5(hist("M5", 20 + k, M5).at(-1)!, closed, null); };
  return { loop, step, kinds: () => loop.decisions().map((d) => [d.kind, d.outcome, d.reason]) };
}

beforeEach(() => { h.ev = { kind: "CANDIDATE", direction: "BUY", state: "READY", trace: { state: "READY", checks: [], at: 0 } }; h.created = 0; h.expiry = undefined; h.terminal = false; h.promote = false; });

describe("Signal Lifecycle Hardening V1", () => {
  it("1. valid context → processed by the existing gates", () => {
    const r = rig(); r.step();
    expect(r.kinds().map((x) => x[0])).toEqual(["CANDIDATE", "GATE"]);
  });
  it("2. invalid context → no READY, rejection audited", () => {
    const r = rig({ m15Shift: 20 * 3 * M5 + 10 * 3_600_000 }); r.step();
    expect(r.kinds()).toEqual([["REJECTED", "SIGNAL_REJECTED", "CONTEXT_M15_STALE"]]);
    expect(r.loop.readiness().m2?.state).not.toBe("READY");
    expect(validateSignalContext({ barCloseMs: 10, m15LastCloseMs: 5, primaryBiasAsOfMs: null })).toBe("CONTEXT_PRIMARY_BIAS_MISSING");
  });
  it("3. context lost after READY → invalidated, never consumed", () => {
    h.ev = { kind: "CANDIDATE", direction: "BUY", state: "REACTION_CONFIRMED", trace: { state: "REACTION_CONFIRMED", checks: [], at: 0 } };
    let stale = false;
    const r = rig({ pbAsOf: () => (stale ? T0 - 13 * 3_600_000 : T0) });
    r.step(); // REACTION_CONFIRMED setup (not consumed)
    expect(r.kinds().map((x) => x[0])).toEqual(["CANDIDATE"]);
    h.promote = true; stale = true; r.step(); // promoted to READY, but H4 context now stale
    expect(r.kinds().at(-1)).toEqual(["REJECTED", "SIGNAL_REJECTED", "CONTEXT_LOST CONTEXT_PRIMARY_BIAS_STALE"]);
    expect(r.kinds().some((x) => x[0] === "GATE")).toBe(false);
  });
  it("4. identical active signal → DUPLICATE_BLOCKED (audited)", () => {
    h.expiry = (T0 + 100 * M5) / 1000;
    const r = rig(); r.step(); r.step();
    expect(r.kinds().map((x) => x[1])).toEqual(["M1B_SETUP", "ALLOW", "DUPLICATE_BLOCKED"]);
    expect(r.kinds().at(-1)![2]).toBe("DUPLICATE_OF s1");
  });
  it("5. after EXPIRED the same setup is evaluated again through all gates", () => {
    h.expiry = (T0 + 22 * M5) / 1000; // active only for the first bar
    const r = rig(); r.step(); r.step(); r.step();
    expect(r.kinds().filter((x) => x[0] === "GATE")).toHaveLength(2);
    expect(r.kinds().some((x) => x[1] === "DUPLICATE_BLOCKED")).toBe(true); // bar 2 still active
  });
  it("6. regime unavailable → UNCERTAIN, mapped only from engine regime", () => {
    const r = rig(); r.step();
    expect(r.loop.decisions()[0]!.context?.regime).toBe("UNCERTAIN");
    expect(regimeLabel(null)).toBe("UNCERTAIN");
    expect(regimeLabel({ regime: "TRANSITION" } as never)).toBe("UNCERTAIN");
    expect(regimeLabel({ regime: "RANGE_COMPRESSION" } as never)).toBe("RANGE");
    expect(regimeLabel({ regime: "TREND_CONTINUATION" } as never)).toBe("TREND");
    expect(regimeLabel({ regime: "VOLATILITY_EXPANSION" } as never)).toBe("HIGH_VOLATILITY");
  });
  it("7. journal/decision log keeps the full audit trail (frozen records)", () => {
    h.expiry = (T0 + 100 * M5) / 1000;
    const r = rig(); r.step(); r.step();
    const d = r.loop.decisions();
    expect(d).toHaveLength(3);
    expect(Object.isFrozen(d[2])).toBe(true);
  });
  it("8b. M15 older than 60 minutes → CONTEXT_M15_STALE (new freshness limit)", () => {
    const r = rig({ m15Shift: 20 * 3 * M5 + 61 * 60_000 }); r.step();
    expect(r.kinds()).toEqual([["REJECTED", "SIGNAL_REJECTED", "CONTEXT_M15_STALE"]]);
    expect(validateSignalContext({ barCloseMs: 61 * 60_000, m15LastCloseMs: 0, primaryBiasAsOfMs: 0 })).toBe("CONTEXT_M15_STALE");
    expect(validateSignalContext({ barCloseMs: 59 * 60_000, m15LastCloseMs: 0, primaryBiasAsOfMs: 0 })).toBeNull();
  });
  it("8c. M5 feed gap > 15 minutes → CONTEXT_M5_STALE", () => {
    expect(validateSignalContext({ barCloseMs: 20 * 60_000, m15LastCloseMs: 0, primaryBiasAsOfMs: 0, m5PrevCloseMs: 0 })).toBe("CONTEXT_M5_STALE");
    expect(validateSignalContext({ barCloseMs: 10 * 60_000, m15LastCloseMs: 0, primaryBiasAsOfMs: 0, m5PrevCloseMs: 0 })).toBeNull();
    expect(validateSignalContext({ barCloseMs: 20 * 60_000, m15LastCloseMs: 0, primaryBiasAsOfMs: 0 })).toBeNull(); // absent ⇒ not checked
  });
  it("8d. regime provider wires the engine regime into the decision log (else UNCERTAIN)", () => {
    const spec = Object.freeze({ symbol: "XAUUSD", origin: "BROKER_REPORTED" as const, digits: 3, point: 0.001, tick_size: 0.001, contract_size: 100, broker_utc_offset_ms: 0 });
    const provider = () => ({ bias: "BUY" as const, asOf: T0, source: "TECHNICAL_H4_CLOSED" as const, arenaStatus: "CARI_BUY" });
    const closed = (tf: Timeframe) => tf === "M5" ? hist("M5", 21, M5) : tf === "M15" ? hist("M15", 20, 3 * M5) : [];
    const regime = { regime: "TREND_CONTINUATION" } as never;
    const a = new LivePaperLoop("XAUUSD", "REAL_MT5", spec, provider, () => regime);
    a.onClosedM5(hist("M5", 21, M5).at(-1)!, closed, null);
    expect(a.decisions()[0]!.context?.regime).toBe("TREND");
    const b = new LivePaperLoop("XAUUSD", "REAL_MT5", spec, provider, () => { throw new Error("boom"); });
    b.onClosedM5(hist("M5", 21, M5).at(-1)!, closed, null);
    expect(b.decisions()[0]!.context?.regime).toBe("UNCERTAIN");
  });
  it("8. restart/persistence never yields a duplicate READY", () => {
    h.expiry = (T0 + 100 * M5) / 1000;
    const a = rig(); a.step();
    const state = a.loop.exportState();
    expect(state.activeSignals).toHaveLength(1);
    const b = rig(); b.loop.restoreState(state); b.step(); b.step();
    expect(b.kinds().map((x) => x[1])).toEqual(["DUPLICATE_BLOCKED"]);
    const reg = new ActiveSignalRegistry(); reg.restore(state.activeSignals); reg.prune(Number.MAX_SAFE_INTEGER);
    expect(reg.export()).toHaveLength(0);
  });
});
