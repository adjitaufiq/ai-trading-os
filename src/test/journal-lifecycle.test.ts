// Journal lifecycle E2E (no broker order): Candidate → Decision → Open sim → Position update → Close sim → Journal record → VPS-disk persistence.
// Same stub rig as decision-gate.test.ts; only observes existing records, never changes the loop.
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
const closedAt = (k: number) => (tf: Timeframe) => tf === "M5" ? hist("M5", 20 + k, M5) : tf === "M15" ? hist("M15", 20, 3 * M5).map((b) => ({ ...b, open_time: b.open_time - (40 - k) * M5, close_time: b.close_time - (40 - k) * M5, available_at: b.available_at - (40 - k) * M5 })) : [];
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

import { MemoryEngineStore, PaperPersistence } from "@/core/enginehost/persistence";
import { resolveBuildInfo, ENGINE_VERSION } from "@/core/enginehost/buildInfo";
import { routeEngineRequest } from "@/core/enginehost/api";

beforeEach(() => { h.ev = null; h.created = 0; h.planned = false; h.closeNext = false; });

describe("journal lifecycle (simulation, no broker order)", () => {
  it("records candidate, ALLOW reason, risk snapshot, open position state, close result and persists the row once", () => {
    h.planned = true;
    const r = run("CARI_BUY", "BUY");
    const store = new MemoryEngineStore();
    const persist = new PaperPersistence(store);

    r.step(); // Candidate → Decision ALLOW → M3 → M4 → open simulation
    expect(r.loop.readiness().gate).toMatchObject({ decision: "ALLOW", reason: "ALLOW_ARENA_BUY_MATCH" });
    expect(r.loop.readiness().m4).toMatchObject({ decision: "APPROVED" });
    expect(r.loop.readiness().openPosition).toBe(true);
    expect(r.loop.exportState().open).not.toBeNull();
    persist.persist(r.loop.exportState());
    expect(store.journals.get("XAUUSD") ?? []).toHaveLength(0); // open position is state, not a journal row yet

    r.step(); // position update, still OPEN
    expect(r.loop.account().openPositions).toBe(1);
    expect(r.loop.trades()).toHaveLength(0);

    h.closeNext = true; r.step(); // close simulation (TP_HIT)
    expect(r.loop.readiness().openPosition).toBe(false);
    const row = r.loop.trades()[0]!;
    expect(row).toMatchObject({ result: "WIN", closeReason: "TP_HIT", exitPrice: 2020, profitLossUSD: 200, lot: 0.1, riskUSD: 100, stopLoss: 1990, takeProfit: 2020 });
    expect(row.entryDecision).toMatchObject({ decision: "ALLOW", reason: "ALLOW_ARENA_BUY_MATCH", arenaStatus: "CARI_BUY", candidateDirection: "BUY", plannedRr: 2, lot: 0.1, riskUSD: 100 });
    expect(row.excursion).toBeDefined();
    expect(r.loop.decisions().map((d) => d.kind)).toEqual(["CANDIDATE", "GATE", "ORDER", "CLOSE"]);
    expect(r.opens).toHaveLength(1); // the demo observer is notified; this test wires no bridge, so no broker order exists

    persist.persist(r.loop.exportState());
    persist.persist(r.loop.exportState());
    const lines = store.journals.get("XAUUSD")!;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ result: "WIN", entryDecision: { reason: "ALLOW_ARENA_BUY_MATCH" } });
  });

  it("BLOCK leaves a GATE record with reason and no position or journal row", () => {
    h.planned = true;
    const r = run("HOLD", "BUY"); r.step();
    expect(r.loop.decisions().at(-1)).toMatchObject({ kind: "GATE", outcome: "BLOCK", reason: "BLOCK_ARENA_HOLD" });
    expect(r.loop.readiness().openPosition).toBe(false);
    expect(r.loop.trades()).toHaveLength(0);
  });
});

describe("engine build info", () => {
  it("never guesses missing commit/build_time", () => {
    expect(resolveBuildInfo(null)).toEqual({ engine_version: ENGINE_VERSION, commit: null, build_time: null, status: "running" });
    expect(resolveBuildInfo({ commit: " c797886 ", build_time: "2026-10-11T04:50:00Z" })).toMatchObject({ commit: "c797886", build_time: "2026-10-11T04:50:00Z" });
  });
  it("GET /v1/engine/version is served read-only", () => {
    const b = resolveBuildInfo({ commit: "abc" });
    const host = { symbols: [], reader: () => null, health: () => ({ symbols: [], build: b }), buildInfo: () => b } as never;
    const res = routeEngineRequest(host, "GET", "/v1/engine/version", 1);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).data).toEqual(b);
    expect(routeEngineRequest(host, "POST", "/v1/engine/version", 1).status).toBe(405);
  });
});
