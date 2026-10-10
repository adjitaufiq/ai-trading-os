// Decision Gate: ARENA operator.status is the entry permission; M1B READY is only a request.
// M1B engines are stubbed (same rig as primary-bias-m2) so the test isolates the gate in LivePaperLoop.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar, Timeframe } from "@/core/contracts";
import { decideEntry } from "@/core/paper/decisionGate";

const h = vi.hoisted(() => ({ ev: null as unknown, created: 0, planned: false, closeNext: false }));

vi.mock("@/engine/core/location/priceLocationEngine", () => ({
  classifyPriceLocation: () => ({ ok: true, context: { priceLocation: "AT_SUPPORT", locationTier: "T1" } }),
  computeAtr: () => 3,
}));
vi.mock("@/engine/core/ema/emaStateEngine", () => ({ computeEMAContext: () => ({ ok: true, context: { actions: [], pricePosition: "ABOVE_ALL" } }) }));
vi.mock("@/engine/core/reaction/reactionEvaluator", () => ({ evaluateReaction: () => ({ ok: true, result: { pattern: "ENGULFING", quality: "STRONG" } }) }));
vi.mock("@/engine/signal/signalEvaluator", () => ({ evaluateSetup: () => h.ev }));
vi.mock("@/engine/signal/signalLifecycle", () => ({
  createSetup: (ev: { direction: "BUY" | "SELL"; state: string }) => { h.created++; return { setup: { id: `s${h.created}`, direction: ev.direction, state: ev.state } }; },
  updateSetup: (s: unknown) => ({ setup: s }),
  isTerminal: (s: { state: string }) => s.state === "INVALIDATED" || s.state === "EXPIRED",
}));
vi.mock("@/engine/plan/tradePlanEngine", () => ({
  buildTradePlan: (i: { setup: { id: string; direction: "BUY" | "SELL" } }) => h.planned
    ? { id: "p1", signalId: i.setup.id, status: "PLANNED", direction: i.setup.direction, entry: 2000, sl: 1990, tp: 2020, rr: 2 }
    : { status: "HOLD", holdReason: "TEST_STOP_AT_PLAN" },
}));
vi.mock("@/engine/risk/riskEngine", () => ({ evaluateRisk: () => ({ decision: "APPROVED", reasons: [] }) }));
const trade = (state: "OPEN" | "CLOSED") => ({
  id: "t1", state, openedAt: 1, closedAt: state === "CLOSED" ? 2 : null,
  result: state === "CLOSED" ? { exit: 2020, profitLossUSD: 200, profitLossPercent: 2, closeReason: "TP_HIT", durationSeconds: 1 } : null,
  snapshot: { symbol: "XAUUSD", direction: "BUY", entryPrice: 2000, stopLoss: 1990, takeProfit: 2020, lot: 0.1, riskUSD: 100, signalSource: { bias: "H4_NEUTRAL_H1_RANGE", location: "AT_SUPPORT", trigger: "ENGULFING", reactionQuality: "STRONG", emaContext: "ABOVE_ALL" }, decisionTrace: [] },
  fill: { marketPrice: 2000, actualEntry: 2000 }, contract: { tickSize: 0.001, tickValue: 0.1 },
});
vi.mock("@/engine/execution/paperExecution", () => ({ createPaperTrade: () => ({ state: "PENDING", trade: trade("OPEN") }) }));
vi.mock("@/engine/execution/tradeLifecycle", () => ({ openPaperTrade: () => ({ ok: true, trade: trade("OPEN") }) }));
vi.mock("@/engine/execution/positionManager", () => ({ updatePosition: () => (h.closeNext ? { ok: true, trade: trade("CLOSED") } : { ok: true, trade: trade("OPEN") }) }));

const { LivePaperLoop } = await import("@/core/paper/LivePaperLoop");

const spec = Object.freeze({ symbol: "XAUUSD", origin: "BROKER_REPORTED" as const, digits: 3, point: 0.001, tick_size: 0.001, contract_size: 100, broker_utc_offset_ms: 0 });
const M5 = 300_000, T0 = 1_700_000_000_000;
const bar = (tf: Timeframe, i: number, ms: number): Bar => ({ symbol: "XAUUSD", timeframe: tf, status: "CLOSED", open_time: T0 + i * ms, close_time: T0 + (i + 1) * ms, available_at: T0 + (i + 1) * ms, open: 2000, high: 2001, low: 1999, close: 2000, tick_count: 1 } as unknown as Bar);
const hist = (tf: Timeframe, n: number, ms: number) => Array.from({ length: n }, (_, i) => bar(tf, i, ms));
const closedAt = (k: number) => (tf: Timeframe) => tf === "M5" ? hist("M5", 20 + k, M5) : tf === "M15" ? hist("M15", 20, 3 * M5).map((b) => ({ ...b, open_time: b.open_time - 20 * 3 * M5, close_time: b.close_time - 20 * 3 * M5, available_at: b.available_at - 20 * 3 * M5 })) : [];
const candidate = (direction: "BUY" | "SELL") => ({ kind: "CANDIDATE", direction, state: "READY", trace: { state: "READY", checks: [], at: 0 } });

/** primaryBias kept equal to the candidate so only the ARENA permission is under test. */
function run(arena: unknown, direction: "BUY" | "SELL", opts: { throws?: boolean } = {}) {
  const provider = () => { if (opts.throws) throw new Error("arena down"); return { bias: direction, asOf: T0, source: "TECHNICAL_H4_CLOSED" as const, arenaStatus: arena as string | null }; };
  const loop = new LivePaperLoop("XAUUSD", "REAL_MT5", spec, provider);
  const events: { type: string; stage: string; reason: string }[] = [];
  const opens: unknown[] = [];
  loop.onPipelineEvent((e) => events.push(e));
  loop.onApprovedOpen((e) => opens.push(e));
  h.ev = candidate(direction);
  let k = 0;
  const step = () => { k++; loop.onClosedM5(hist("M5", 20 + k, M5).at(-1)!, closedAt(k), null); };
  return { loop, events, opens, step };
}

beforeEach(() => { h.ev = null; h.created = 0; h.planned = false; h.closeNext = false; });

describe("decideEntry (pure)", () => {
  it.each([
    ["CARI_BUY", "BUY", "ALLOW", "ALLOW_ARENA_BUY_MATCH"],
    ["CARI_SELL", "SELL", "ALLOW", "ALLOW_ARENA_SELL_MATCH"],
    ["CARI_BUY", "SELL", "BLOCK", "BLOCK_DIRECTION_MISMATCH"],
    ["CARI_SELL", "BUY", "BLOCK", "BLOCK_DIRECTION_MISMATCH"],
    ["HOLD", "BUY", "BLOCK", "BLOCK_ARENA_HOLD"],
    ["WAIT", "BUY", "BLOCK", "BLOCK_ARENA_INVALID"],
    ["MIXED", "SELL", "BLOCK", "BLOCK_ARENA_INVALID"],
    [null, "BUY", "BLOCK", "BLOCK_ARENA_INVALID"],
    [undefined, "SELL", "BLOCK", "BLOCK_ARENA_INVALID"],
    [42, "BUY", "BLOCK", "BLOCK_ARENA_INVALID"],
    ["CARI_BUY", "NONE", "BLOCK", "BLOCK_DIRECTION_MISMATCH"],
  ] as const)("%s + %s → %s %s", (s, c, d, r) => {
    const g = decideEntry(s, c);
    expect(g.decision).toBe(d); expect(g.reason).toBe(r);
  });
});

describe("Decision Gate in LivePaperLoop", () => {
  it("Case 1: ARENA CARI_BUY + M1B BUY READY → ALLOW, continues to existing plan stage", () => {
    const r = run("CARI_BUY", "BUY"); r.step();
    expect(r.loop.readiness().gate?.reason).toBe("ALLOW_ARENA_BUY_MATCH");
    expect(r.events.map((e) => e.type)).toEqual(["READY", "BLOCKED"]);
    expect(r.events[1]!.stage).toBe("PLAN");
    expect(r.loop.decisions().map((d) => [d.kind, d.outcome])).toEqual([["CANDIDATE", "M1B_SETUP"], ["GATE", "ALLOW"]]);
  });

  it("Case 2: ARENA CARI_BUY + M1B SELL READY → BLOCK_DIRECTION_MISMATCH, no READY/plan", () => {
    const r = run("CARI_BUY", "SELL"); r.step();
    expect(r.loop.account().lastDecision).toBe("GATE_BLOCK BLOCK_DIRECTION_MISMATCH");
    expect(r.events).toEqual([expect.objectContaining({ type: "BLOCKED", stage: "DECISION", reason: "BLOCK_DIRECTION_MISMATCH" })]);
  });

  it("Case 3: ARENA HOLD + M1B BUY READY → BLOCK_ARENA_HOLD, no position", () => {
    h.planned = true;
    const r = run("HOLD", "BUY"); r.step();
    expect(r.loop.account().lastDecision).toBe("GATE_BLOCK BLOCK_ARENA_HOLD");
    expect(r.loop.account().openPositions).toBe(0);
    expect(r.opens).toHaveLength(0);
  });

  it.each([null, undefined, "WAIT", "MIXED", "garbage"])("Case 4: ARENA status %s → BLOCK_ARENA_INVALID, no position", (s) => {
    h.planned = true;
    const r = run(s, "BUY"); r.step();
    expect(r.loop.account().lastDecision).toBe("GATE_BLOCK BLOCK_ARENA_INVALID");
    expect(r.opens).toHaveLength(0);
  });

  it("Case 4b: ARENA evaluation throws → fails closed, no position", () => {
    h.planned = true;
    const r = run("CARI_BUY", "BUY", { throws: true }); r.step();
    expect(r.loop.account().openPositions).toBe(0);
    expect(r.opens).toHaveLength(0);
  });

  it("ALLOW reaches the existing open path; demo observer and journal OPEN/CLOSE lifecycle recorded", () => {
    h.planned = true;
    const r = run("CARI_BUY", "BUY"); r.step();
    expect(r.loop.account().openPositions).toBe(1);
    expect(r.opens).toHaveLength(1); // demo bridge only ever receives gated opens
    h.closeNext = true; r.step();
    const row = r.loop.trades()[0]!;
    expect(row.entryDecision).toMatchObject({ decision: "ALLOW", reason: "ALLOW_ARENA_BUY_MATCH", arenaStatus: "CARI_BUY", primaryBias: "BUY", stopLoss: 1990, takeProfit: 2020, plannedRr: 2, trigger: "ENGULFING", priceLocation: "AT_SUPPORT" });
    expect(row.excursion).toBeDefined();
    expect(r.loop.decisions().map((d) => [d.kind, d.outcome])).toEqual([["CANDIDATE", "M1B_SETUP"], ["GATE", "ALLOW"], ["ORDER", "CREATED"], ["CLOSE", "WIN"]]);
    expect(r.loop.decisions().at(-1)).toMatchObject({ rr: 2 });
  });
});
