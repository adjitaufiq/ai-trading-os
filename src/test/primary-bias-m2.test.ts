// PrimaryBias → M2 gate for the paper loop. M1B/M2 engines are stubbed so the test isolates the gate in LivePaperLoop:
// the evaluator proposes a candidate direction (S/R location), H4 primaryBias decides whether it may exist.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar, Timeframe } from "@/core/contracts";

const h = vi.hoisted(() => ({ ev: null as unknown, update: null as null | ((s: { direction: string }) => unknown), created: 0 }));

vi.mock("@/engine/core/location/priceLocationEngine", () => ({
  classifyPriceLocation: () => ({ ok: true, context: { priceLocation: "AT_SUPPORT", locationTier: "T1" } }),
  computeAtr: () => 3,
}));
vi.mock("@/engine/core/ema/emaStateEngine", () => ({ computeEMAContext: () => ({ ok: true, context: { actions: [], pricePosition: "ABOVE_ALL" } }) }));
vi.mock("@/engine/core/reaction/reactionEvaluator", () => ({ evaluateReaction: () => ({ ok: true, result: { pattern: "ENGULFING", quality: "STRONG" } }) }));
vi.mock("@/engine/signal/signalEvaluator", () => ({ evaluateSetup: () => h.ev }));
vi.mock("@/engine/signal/signalLifecycle", () => ({
  createSetup: (ev: { direction: "BUY" | "SELL"; state: string }) => { h.created++; return { setup: { id: `s${h.created}`, direction: ev.direction, state: ev.state } }; },
  updateSetup: (s: { direction: string }) => ({ setup: h.update ? h.update(s) : s }),
  isTerminal: (s: { state: string }) => s.state === "INVALIDATED" || s.state === "EXPIRED",
}));
vi.mock("@/engine/plan/tradePlanEngine", () => ({ buildTradePlan: () => ({ status: "HOLD", holdReason: "TEST_STOP_AT_PLAN" }) }));

const { LivePaperLoop } = await import("@/core/paper/LivePaperLoop");
type Reading = import("@/core/paper/LivePaperLoop").PrimaryBiasReading;

const spec = Object.freeze({ symbol: "XAUUSD", origin: "BROKER_REPORTED" as const, digits: 3, point: 0.001, tick_size: 0.001, contract_size: 100, broker_utc_offset_ms: 0 });
const M5 = 300_000, T0 = 1_700_000_000_000;
const bar = (tf: Timeframe, i: number, ms: number): Bar => ({ symbol: "XAUUSD", timeframe: tf, status: "CLOSED", open_time: T0 + i * ms, close_time: T0 + (i + 1) * ms, available_at: T0 + (i + 1) * ms, open: 2000, high: 2001, low: 1999, close: 2000, tick_count: 1 } as unknown as Bar);
const hist = (tf: Timeframe, n: number, ms: number) => Array.from({ length: n }, (_, i) => bar(tf, i, ms));
const closedAt = (k: number) => (tf: Timeframe) => tf === "M5" ? hist("M5", 20 + k, M5) : tf === "M15" ? hist("M15", 20, 3 * M5).map((b) => ({ ...b, open_time: b.open_time - (k - 40) * M5, close_time: b.close_time - (k - 40) * M5, available_at: b.available_at - (k - 40) * M5 })) : [];
const candidate = (direction: "BUY" | "SELL", state = "READY") => ({ kind: "CANDIDATE", direction, state, trace: { state, checks: [], at: 0 } });

function run(bias: Reading["bias"] | "MISSING" | "NO_PROVIDER", direction: "BUY" | "SELL") {
  let current = bias;
  const provider = bias === "NO_PROVIDER" ? undefined : () => (current === "MISSING" ? null : { bias: current as Reading["bias"], asOf: T0, source: "TECHNICAL_H4_CLOSED" as const, arenaStatus: current === "BUY" ? "CARI_BUY" : current === "SELL" ? "CARI_SELL" : "HOLD" });
  const loop = new LivePaperLoop("XAUUSD", "REAL_MT5", spec, provider);
  const events: { type: string; direction: string | null }[] = [];
  loop.onPipelineEvent((e) => events.push(e));
  h.ev = candidate(direction);
  let k = 0;
  const step = () => { k++; loop.onClosedM5(hist("M5", 20 + k, M5).at(-1)!, closedAt(k), null); };
  return { loop, events, step, setBias: (b: typeof bias) => { current = b; } };
}

beforeEach(() => { h.ev = null; h.update = null; h.created = 0; });

describe("PrimaryBias → M2 paper gate", () => {
  it("A. H4 SELL + bullish M15/M5 reaction → BUY rejected before createSetup", () => {
    const r = run("SELL", "BUY"); r.step();
    expect(h.created).toBe(0);
    expect(r.events.filter((e) => e.type === "READY")).toHaveLength(0);
    expect(r.loop.account().lastDecision).toBe("NO_SETUP BLOCK_COUNTER_PRIMARY_BIAS");
  });

  it("B. H4 BUY + bearish M15/M5 reaction → SELL rejected before createSetup", () => {
    const r = run("BUY", "SELL"); r.step();
    expect(h.created).toBe(0);
    expect(r.loop.account().lastDecision).toBe("NO_SETUP BLOCK_COUNTER_PRIMARY_BIAS");
  });

  it.each(["NONE", "MISSING"] as const)("C. H4 %s → no READY setup, no S/R fallback", (b) => {
    for (const d of ["BUY", "SELL"] as const) {
      h.created = 0;
      const r = run(b, d); r.step();
      expect(h.created).toBe(0);
      expect(r.events.filter((e) => e.type === "READY")).toHaveLength(0);
      expect(r.loop.account().lastDecision).toBe("NO_SETUP NO_PRIMARY_BIAS");
    }
  });

  it("D. H4 SELL + valid SELL trigger → allowed (READY reaches plan stage)", () => {
    const r = run("SELL", "SELL"); r.step();
    expect(h.created).toBe(1);
    expect(r.events.map((e) => [e.type, e.direction])).toEqual([["READY", "SELL"], ["BLOCKED", "SELL"]]);
    expect(r.loop.account().lastDecision).toBe("PLAN_HOLD TEST_STOP_AT_PLAN");
  });

  it("E. H4 bias flip while a setup is pending → setup invalidated, never READY", () => {
    const r = run("BUY", "BUY");
    h.ev = candidate("BUY", "WAITING_REACTION");
    r.step();
    expect(h.created).toBe(1);
    // next bar: lifecycle would promote to READY, but H4 flipped to SELL
    h.update = (s) => ({ ...s, state: "READY" });
    h.ev = candidate("BUY", "READY");
    r.setBias("SELL"); r.step();
    expect(r.events.filter((e) => e.type === "READY")).toHaveLength(0);
    expect(r.loop.exportState().setup).toBeNull();
    expect(r.loop.account().lastDecision).toBe("NO_SETUP BLOCK_COUNTER_PRIMARY_BIAS");
    expect(h.created).toBe(1);
  });

  it("F. replay without PrimaryBiasProvider → fail closed", () => {
    for (const d of ["BUY", "SELL"] as const) {
      h.created = 0;
      const r = run("NO_PROVIDER", d); r.step();
      expect(h.created).toBe(0);
      expect(r.events).toHaveLength(0);
      expect(r.loop.account().lastDecision).toBe("NO_SETUP NO_PRIMARY_BIAS");
    }
  });

  it("provider that throws fails closed", () => {
    const loop = new LivePaperLoop("XAUUSD", "REAL_MT5", spec, () => { throw new Error("boom"); });
    h.ev = candidate("BUY");
    loop.onClosedM5(hist("M5", 21, M5).at(-1)!, closedAt(1), null);
    expect(h.created).toBe(0);
    expect(loop.account().lastDecision).toBe("NO_SETUP NO_PRIMARY_BIAS");
  });
});
