import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { MarketEventEngine } from "../eventEngine";
import { InMemoryEventStore } from "../eventStore";
import { createEvent } from "../eventLifecycle";
import type { EventObservation } from "../types";
import type { MarketRegimeSnapshot, MarketRegimeType } from "../../regime/types";
import type { TradingStyleContext } from "../../horizon/types";
import type { InstitutionalFootprints } from "../../institutional-radar/types";

const regime = (t: number, r: MarketRegimeType = "TREND_CONTINUATION", vol: MarketRegimeSnapshot["volatility"] = "NORMAL", sym = "BTCUSD"): MarketRegimeSnapshot => ({
  symbol: sym, asOf: t, regime: r, trendAlignment: "ALIGNED", volatility: vol,
  structureContext: { monthly: "UNAVAILABLE", weekly: "UNAVAILABLE", daily: "UNAVAILABLE", h4: "BULLISH", h1: "BULLISH" },
  rangeContext: { rangeWidth: 30, atrCurrent: 10, atrPercentile: 0.5, atrState: vol }, evidence: [], algorithmVersion: "m1b9-regime-v1",
});
const horizon = (t: number, sym = "BTCUSD"): TradingStyleContext => ({
  symbol: sym, asOf: t, regimeSnapshotId: "x", recommendedHorizon: "INTRADAY", compatibleHorizons: ["INTRADAY"],
  marketApproach: "TREND_FOLLOW", holdingEnvironment: "SESSION_HORIZON",
  horizonEvidence: { macroTrend: "BULLISH", intradayStructure: "CLEAN", microCondition: "MOMENTUM", atrPercentile: 0.5, tags: ["REGIME_X", "FOOTPRINT_SWEEP"] },
  evidence: [], algorithmVersion: "m1b10-style-v1",
});
const fp = (t: number, sweep = true): InstitutionalFootprints => ({
  sweepDetected: sweep, sweepDirection: sweep ? "BULLISH" : null, sweepWickDistance: 1, sweepAgeBars: 0,
  displacementPreceded: false, displacementMagnitude: 0, insideFVG: false, activeFVGId: null, insideOrderBlock: false, activeOrderBlockId: null, timestamp: t,
});
const T = (i: number) => 1_700_000_000 + i * 300;
const obs = (i: number, o: Partial<EventObservation> = {}): EventObservation => ({
  symbol: "BTCUSD", timeframe: "M5", barTime: T(i), regime: regime(T(i)), horizon: horizon(T(i)), footprints: fp(T(i), false), footprintTimeframe: "M5", ...o,
});

describe("M1B.11 market event radar", () => {
  it("1 liquidity sweep detection → ACTIVE", () => {
    const eng = new MarketEventEngine();
    const [e] = eng.step(obs(0, { footprints: fp(T(0)) }));
    expect(e).toMatchObject({ type: "LIQUIDITY_SWEEP", state: "ACTIVE", timeframe: "M5", endedAt: null, endedReason: null, occurrenceCount: 1 });
    expect(e!.context.footprintTags).toEqual(["FOOTPRINT_SWEEP"]);
    expect(Object.isFrozen(e)).toBe(true);
  });

  it("2 dedup: 3 sweeps inside cooldown → one event, occurrenceCount 3", () => {
    const eng = new MarketEventEngine();
    for (let i = 0; i < 3; i++) eng.step(obs(i, { footprints: fp(T(i)) }));
    const all = eng.store.queryEvents({ type: "LIQUIDITY_SWEEP" });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ occurrenceCount: 3, lastOccurredAt: T(2), createdAt: T(0) });
  });

  it("3 reaction resolves sweep with causal link", () => {
    const eng = new MarketEventEngine();
    const [sweep] = eng.step(obs(0, { footprints: fp(T(0)) }));
    eng.step(obs(1));
    const out = eng.step(obs(2, { reactionConfirmed: true }));
    const resolved = eng.store.getEvent(sweep!.eventId)!;
    expect(resolved).toMatchObject({ state: "RESOLVED", endedReason: "RESOLVED", endedAt: T(2) });
    const rc = out.find((e) => e.type === "REACTION_CONFIRMED")!;
    expect(rc.resolvesEventId).toBe(sweep!.eventId);
  });

  it("4 expiry after 20 bars → EXPIRED + WATCH_INVALIDATED", () => {
    const eng = new MarketEventEngine();
    const [sweep] = eng.step(obs(0, { footprints: fp(T(0)) }));
    let out: readonly unknown[] = [];
    for (let i = 1; i <= 20; i++) out = eng.step(obs(i));
    expect(eng.store.getEvent(sweep!.eventId)).toMatchObject({ state: "EXPIRED", endedReason: "EXPIRED", endedAt: T(20) });
    const wi = eng.store.queryEvents({ type: "WATCH_INVALIDATED" });
    expect(wi).toHaveLength(1);
    expect(wi[0]!.resolvesEventId).toBe(sweep!.eventId);
    expect(out).toHaveLength(2);
    expect(eng.store.getEvent(sweep!.eventId) ).not.toBeNull();
  });

  it("5 regime transition → REGIME_CHANGE with null timeframe; volatility expansion has M15", () => {
    const eng = new MarketEventEngine();
    eng.step(obs(0));
    const out = eng.step(obs(1, { regime: regime(T(1), "RANGE_COMPRESSION") }));
    expect(out.map((e) => e.type)).toEqual(["REGIME_CHANGE"]);
    expect(out[0]).toMatchObject({ timeframe: null, evidence: ["REGIME_TREND_CONTINUATION_TO_RANGE_COMPRESSION"] });
    const v = eng.step(obs(2, { regime: regime(T(2), "VOLATILITY_EXPANSION", "EXPANSION") }));
    expect(v.find((e) => e.type === "VOLATILITY_EXPANSION")).toMatchObject({ timeframe: "M15", severity: "CRITICAL" });
    expect(() => createEvent({ symbol: "X", type: "REGIME_CHANGE", timeframe: "M5", at: 1, context: out[0]!.context, evidence: [] })).toThrow();
    expect(() => createEvent({ symbol: "X", type: "LIQUIDITY_SWEEP", timeframe: null, at: 1, context: out[0]!.context, evidence: [] })).toThrow();
  });

  it("6 BTC 24/7 stress: 10000 candles, no spam, deterministic, bounded memory", () => {
    const run = () => {
      const eng = new MarketEventEngine();
      const regs: MarketRegimeType[] = ["TREND_CONTINUATION", "RANGE_COMPRESSION", "TRANSITION"];
      for (let i = 0; i < 10_000; i++) {
        eng.step(obs(i, {
          footprints: fp(T(i), i % 7 < 3),
          regime: regime(T(i), regs[Math.floor(i / 500) % 3], i % 900 < 30 ? "EXPANSION" : "NORMAL"),
          reactionConfirmed: i % 97 === 0,
          snrInteractions: i % 11 === 0 ? [{ levelId: `L${i % 3}`, timeframe: "M15", side: "SUPPORT" }] : [],
        }));
      }
      return eng;
    };
    const a = run(), b = run();
    const sa = JSON.stringify(a.store.exportSnapshot(T(10_000))), sb = JSON.stringify(b.store.exportSnapshot(T(10_000)));
    expect(sa).toBe(sb);
    const sweeps = a.store.queryEvents({ type: "LIQUIDITY_SWEEP" }).length;
    expect(sweeps).toBeLessThan(10_000 / 7 + 1); // ≤ one event per sweep burst
    expect(a.trackerCount("BTCUSD")).toBeLessThan(20);
    expect(a.store.getActiveEvents("BTCUSD").length).toBeLessThan(10);
  });

  it("7 future leakage: snapshot at T unchanged after appending T+1", () => {
    const eng = new MarketEventEngine();
    eng.step(obs(0, { footprints: fp(T(0)) }));
    const snap = JSON.stringify(eng.store.exportSnapshot(T(0)));
    eng.step(obs(1, { footprints: fp(T(1)), reactionConfirmed: true }));
    expect(JSON.stringify(eng.store.exportSnapshot(T(0)))).toBe(snap);
    // future-dated inputs ignored
    const e2 = new MarketEventEngine();
    expect(e2.step(obs(0, { footprints: fp(T(5)) }))).toHaveLength(0);
    const store = new InMemoryEventStore();
    expect(() => store.saveEvent(eng.store.queryEvents()[0]!, 0)).not.toThrow();
    expect(() => store.saveEvent(eng.store.queryEvents()[0]!, -1)).toThrow();
  });

  it("8 architecture purity + zero decision fields", () => {
    const dir = join(__dirname, "..");
    const forbidden = [/\/signal\//, /\/plan\//, /\/risk\//, /\/execution\//, /\/journal\//, /broker/i, /probe/];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const imp of imports) for (const re of forbidden) expect(re.test(imp), `${f} imports ${imp}`).toBe(false);
    }
    const eng = new MarketEventEngine();
    const [e] = eng.step(obs(0, { footprints: fp(T(0)) }));
    const keys = Object.keys(e!).join(",").toLowerCase();
    for (const k of ["score", "confidence", "probability", "sl", "tp", "lot", "entry", "side", "direction", "risk"]) {
      expect(keys.split(",")).not.toContain(k);
    }
    expect(JSON.stringify(e)).not.toMatch(/"(BUY|SELL)"/);
  });
});
