import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MarketRegimeSnapshot } from "../../core/market/regime/types";
import type { TradingStyleContext } from "../../core/market/horizon/types";
import type { InstitutionalFootprints } from "../../core/market/institutional-radar/types";
import type { MarketEvent } from "../../core/market/events/types";
import type { MarketStructure, SwingPoint } from "../../core/swing/types";
import { buildTradePlan } from "../../plan/tradePlanEngine";
import { createPaperTrade } from "../../execution/paperExecution";
import { closePaperTrade, openPaperTrade } from "../../execution/tradeLifecycle";
import { input as execInput } from "../../execution/tests/helpers";
import { TradeJournal, fromPaperTrade } from "../../journal/tradeJournal";
import { evaluateSetup } from "../signalEvaluator";
import { createSetup, updateSetup } from "../signalLifecycle";
import { captureMarketContext, type MarketContextSources } from "../context";
import { T0, ema, input, m5 } from "./helpers";

const regime = (asOf = T0): MarketRegimeSnapshot => ({
  symbol: "XAUUSD", asOf, regime: "TREND_CONTINUATION", trendAlignment: "ALIGNED", volatility: "NORMAL",
  structureContext: {} as MarketRegimeSnapshot["structureContext"], rangeContext: {} as MarketRegimeSnapshot["rangeContext"],
  evidence: ["h4 aligned"], algorithmVersion: "m1b9-regime-v1",
});
const horizon = (asOf = T0): TradingStyleContext => ({
  symbol: "XAUUSD", asOf, regimeSnapshotId: "r1", recommendedHorizon: "INTRADAY", compatibleHorizons: ["INTRADAY", "SCALPING"],
  marketApproach: "TREND_FOLLOW", holdingEnvironment: "SESSION_HORIZON", horizonEvidence: {} as TradingStyleContext["horizonEvidence"],
  evidence: ["x"], algorithmVersion: "m1b10-style-v1",
});
const fp = (): InstitutionalFootprints => ({
  sweepDetected: true, sweepDirection: "BULLISH", sweepWickDistance: 1, sweepAgeBars: 0, displacementPreceded: false,
  displacementMagnitude: 0, insideFVG: false, activeFVGId: null, insideOrderBlock: false, activeOrderBlockId: null, timestamp: T0,
});
const ev = (id: string, createdAt: number, endedAt: number | null = null): MarketEvent => ({
  eventId: id, symbol: "XAUUSD", timeframe: "M5", type: "LIQUIDITY_SWEEP" as MarketEvent["type"], severity: "IMPORTANT",
  state: endedAt === null ? "ACTIVE" : "EXPIRED", createdAt, endedAt, endedReason: endedAt === null ? null : "EXPIRED",
  occurrenceCount: 1, lastOccurredAt: createdAt, resolvesEventId: null,
  context: { regime: "TREND_CONTINUATION", horizon: "INTRADAY", approach: "TREND_FOLLOW", footprintTags: [] } as MarketEvent["context"],
  evidence: [], algorithmVersion: "m1b11-event-v1",
});
const sources = (): MarketContextSources => ({ regime: regime(), horizon: horizon(), footprints: fp(), events: [ev("XAU_SWEEP_1", T0 - 300), ev("FUTURE", T0 + 300), ev("OLD", T0 - 900, T0 - 300)] });

const born = (ctx?: MarketContextSources) => {
  const i = input();
  const r = createSetup(evaluateSetup(i), i, i.reaction!, m5(0, 2651), 2651, ctx);
  if (!r) throw new Error("not created");
  return r.setup;
};
const strip = <T extends object>(o: T) => { const { marketContext: _m, ...rest } = o as T & { marketContext?: unknown }; return rest; };

describe("M2 context enrichment (m2-context-v1)", () => {
  it("1 backward compatibility: no context ⇒ valid setup without marketContext", () => {
    const s = born();
    expect(s.state).toBe("READY");
    expect("marketContext" in s).toBe(false);
  });

  it("2 attaches causal context with EventReference only", () => {
    const m = born(sources()).marketContext!;
    expect(m.contextVersion).toBe("m2-context-v1");
    expect(m.capturedAt).toBe(T0);
    expect(m.regime?.regime).toBe("TREND_CONTINUATION");
    expect(m.horizon?.recommendedHorizon).toBe("INTRADAY");
    expect(m.activeEvents).toEqual([{ eventId: "XAU_SWEEP_1", type: "LIQUIDITY_SWEEP", severity: "IMPORTANT", state: "ACTIVE", timeframe: "M5" }]);
    expect(Object.keys(m.activeEvents[0]).sort()).toEqual(["eventId", "severity", "state", "timeframe", "type"]);
    expect(captureMarketContext({ regime: regime(T0 + 1) }, T0).regime).toBeNull();
  });

  it("3 lifecycle isolation: identical states/traces with and without context", () => {
    const a = born(), b = born(sources());
    expect(strip(b)).toEqual(a);
    const u = { m5: m5(1, 2652), price: 2652, m15Atr: 4, m15StructureShift: "NONE" as const, emaContext: ema([]), now: T0 + 600 };
    const ua = updateSetup(a, u), ub = updateSetup(b, u);
    expect(strip(ub.setup)).toEqual(ua.setup);
    expect(ub.trace).toEqual(ua.trace);
    expect(ub.setup.marketContext).toBe(b.marketContext);
  });

  it("4 immutability: mutating sources does not alter snapshot", () => {
    const src = sources() as any;
    const s = born(src);
    const before = structuredClone(s.marketContext);
    src.regime.regime = "RANGE"; src.regime.evidence.push("mut"); src.footprints.sweepDetected = false; src.events[0].severity = "INFO";
    expect(s.marketContext).toEqual(before);
    expect(Object.isFrozen(s.marketContext!.regime!.evidence)).toBe(true);
    expect(() => { (s.marketContext as any).capturedAt = 1; }).toThrow();
  });

  it("5 historical replay: snapshot at T unchanged by T+1 data", () => {
    const src = sources();
    const t = captureMarketContext(src, T0);
    const later = { ...src, events: [...src.events!, ev("NEW", T0 + 300)], regime: regime(T0 + 300) };
    expect(captureMarketContext(later, T0)).toEqual({ ...t, regime: null });
    expect(captureMarketContext(src, T0)).toEqual(t);
  });

  it("6 propagation Signal → Plan → Execution → Journal", () => {
    const s = born(sources());
    const sw = (type: "HIGH" | "LOW", price: number): SwingPoint => ({ id: type + price, symbol: "XAUUSD", timeframe: "M15", type, price, timestamp: T0 - 3600, confirmedAt: T0 - 900, strength: "NORMAL", leftBars: 2, rightBars: 2, rejectionWickRatio: 0 });
    const st: MarketStructure = { symbol: "XAUUSD", timeframe: "M15", trend: "HH_HL", lastConfirmedHigh: sw("HIGH", 2662), lastConfirmedLow: sw("LOW", 2648), previousHigh: sw("HIGH", 2670), previousLow: sw("LOW", 2640), structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: T0 };
    const plan = buildTradePlan({ setup: s, entry: 2651, m15Structure: st, atrM15: 4, now: T0 });
    const planNoCtx = buildTradePlan({ setup: strip(s) as typeof s, entry: 2651, m15Structure: st, atrM15: 4, now: T0 });
    expect(plan.status).toBe("PLANNED");
    expect(strip(plan)).toEqual(planNoCtx);
    expect(plan.marketContext).toEqual(s.marketContext);
    const c = createPaperTrade(execInput({ plan, marketPrice: 2651 }));
    if (c.state !== "PENDING") throw new Error("rejected");
    expect(c.trade.snapshot.marketContext).toEqual(s.marketContext);
    const o = openPaperTrade(c.trade, T0); if (!o.ok) throw new Error();
    const cl = closePaperTrade(o.trade, "TP_HIT", plan.tp!, T0 + 900); if (!cl.ok) throw new Error();
    const row = fromPaperTrade(cl.trade, { h1Phase: "PULLBACK", locationTier: "TIER_1", rr: plan.rr! })!;
    expect(row.contextSnapshot).toEqual({ regime: "TREND_CONTINUATION", horizon: "INTRADAY", marketApproach: "TREND_FOLLOW", footprintTags: ["SWEEP_BULLISH"], eventReferences: s.marketContext!.activeEvents });
    const saved = new TradeJournal().saveTrade(row);
    expect(saved.ok && saved.trade.contextSnapshot).toEqual(row.contextSnapshot);
  });

  it("7 architecture scan: signal module imports no broker/execution/risk/order and never reads marketContext", () => {
    const dir = join(__dirname, "..");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(i).not.toMatch(/broker|execution|risk|order|plan\//);
      if (f !== "context.ts" && f !== "types.ts") expect(src.replace(/marketContext: captureMarketContext/, "")).not.toMatch(/marketContext/);
    }
    const planSrc = readFileSync(join(dir, "..", "plan/tradePlanEngine.ts"), "utf8");
    expect(planSrc.split("\n").filter((l) => l.includes("marketContext"))).toEqual(["    ...(s.marketContext ? { marketContext: s.marketContext } : {}),"]);
    for (const m of ["risk", "plan"]) for (const f of readdirSync(join(dir, "..", m)).filter((x) => x.endsWith(".ts") && x !== "types.ts" && x !== "tradePlanEngine.ts"))
      expect(readFileSync(join(dir, "..", m, f), "utf8")).not.toMatch(/marketContext/);
  });
});
