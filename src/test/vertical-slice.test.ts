import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { EXECUTION_ENABLED } from "@/core/contracts";
import { atrWilder, ema, engulfing, geometry, rsiWilder, structureOf, type TechBar } from "@/core/technical/indicators";
import { ALL_SIGNAL_STATES, TransitionTrail, asLastKnown, deriveReferencePlan, evaluate, rsiDirectionGate, type EvaluationInput } from "@/core/technical/tradingState";
import { TechnicalSliceService, toTechBar } from "@/core/technical/TechnicalSliceService";
import type { Bar, Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader, MarketRuntimeSnapshot } from "@/core/runtime/MarketRuntime";

const TF = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
function series(tf: keyof typeof TF, closes: number[], start = 1_700_000_000_000): TechBar[] {
  return closes.map((c, i) => { const open_time = start + i * TF[tf];
    return { open_time, close_time: open_time + TF[tf], available_at: open_time + TF[tf], open: c, high: c + 0.5, low: c - 0.5, close: c }; });
}
// zig-zag uptrend: confirmed HH/HL
const up = (k: number) => Array.from({ length: k }, (_, i) => 100 + i * 0.3 + [0, 1, 2, 3, 4, 3, 2, 1][i % 8]!);
const bullEngulfM5 = () => { const b = series("M5", up(40)); const p = b[b.length - 2]!, l = b[b.length - 1]!;
  b[b.length - 2] = { ...p, open: 120, close: 119, high: 120.2, low: 118.8 }; b[b.length - 1] = { ...l, open: 118.9, close: 121, high: 121.2, low: 118.7 }; return b; };
// Operator v2 needs location: quote sits on the H1 EMA21 (EMA21/50 confluence) of the uptrend fixture.
const H1_EMA21 = (ema(series("H1", up(60)), 21) as { value: number }).value;
const base = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  symbol: "XAUUSD", market_current: true, bars_current: true,
  quote: { bid: H1_EMA21 - 0.1, ask: H1_EMA21 + 0.1, spread: 0.2, tick_time_ms: 1, observed_at: 2 },
  closed: { M5: bullEngulfM5(), M15: series("M15", up(40)), H1: series("H1", up(60)), H4: series("H4", up(60)) },
  as_of: 10, env: { operating_mode: "MONITOR_ONLY", execution_enabled: false }, ...over,
});

describe("vertical slice — indicators", () => {
  it("EMA seeded SMA, ATR/RSI Wilder, insufficient history explicit (no zeroes)", () => {
    const b = series("H1", [1, 2, 3, 4, 5]);
    expect(ema(b, 5)).toMatchObject({ status: "OK", value: 3 });
    expect(ema(b, 21)).toEqual({ status: "INSUFFICIENT_HISTORY", required: 21, have: 5 });
    expect(atrWilder(b).status).toBe("INSUFFICIENT_HISTORY");
    const r = rsiWilder(series("H1", Array.from({ length: 20 }, (_, i) => 100 + i)));
    expect(r).toMatchObject({ status: "OK", value: 100 });
  });
  it("candle geometry never divides by zero", () => {
    expect(geometry({ open_time: 0, close_time: 1, available_at: 1, open: 1, high: 1, low: 1, close: 1 }).body_to_range).toBeNull();
  });
  it("engulfing definition", () => {
    const p = { open_time: 0, close_time: 1, available_at: 1, open: 10, high: 10.5, low: 8.5, close: 9 };
    expect(engulfing(p, { ...p, open: 9, close: 10.5 })).toEqual({ bullish: true, bearish: false });
    expect(engulfing(p, { ...p, open: 9, close: 9.5 }).bullish).toBe(false);
  });
  it("causal swings: confirmation at 2nd right bar, no retrospective leak", () => {
    const b = series("H1", up(30));
    const full = structureOf(b).swings, prefix = structureOf(b.slice(0, 20)).swings;
    for (const s of prefix) expect(full).toContainEqual(s);
    for (const s of full) expect(s.available_at).toBeGreaterThan(s.pivot_time);
  });
});

describe("vertical slice — four-state contract", () => {
  const un = evaluate(base({ market_current: false }));
  it("UNAVAILABLE ≠ NEUTRAL/INACTIVE/WAITING and blocks execution", () => {
    expect(un.availability).toBe("UNAVAILABLE");
    expect(un.bias.state).toBe("NOT_EVALUABLE");
    expect(un.setup.state).toBe("NOT_EVALUABLE");
    expect(un.signal.state).toBe("NOT_EVALUABLE");
    expect(un.execution).toMatchObject({ state: "BLOCKED" });
    expect(un.execution.reasons[0]).toBe("MARKET_STATE_UNAVAILABLE");
  });
  it("SignalState has no INHIBITED", () => { expect(ALL_SIGNAL_STATES).not.toContain("INHIBITED" as never); });
  it("baseline BUY / ACTIVE / READY on closed engulfing, execution BLOCKED in MONITOR_ONLY", () => {
    const s = evaluate(base());
    expect(s.bias.state).toBe("BUY");
    expect(s.setup.state).toBe("ACTIVE");
    expect(s.signal).toMatchObject({ state: "READY", reason: "M5_CLOSED_BULLISH_BULLISH_ENGULFING", validity_policy: "RESEARCH_REQUIRED" });
    expect(s.execution.state).toBe("BLOCKED");
    expect(s.execution.reasons).toContain("CAPABILITY_UNAUTHORIZED");
    expect(EXECUTION_ENABLED).toBe(false);
    expect(s.reference_plan.status).toBe("AVAILABLE");
    if (s.reference_plan.status === "AVAILABLE") {
      const latestLow = [...s.evidence!.H1.structure.swings].reverse().find((swing) => swing.kind === "LOW")!;
      const atr = (s.evidence!.M15.atr14 as { status: "OK"; value: number }).value;
      const expectedSl = s.quote!.ask - (s.quote!.ask - (latestLow.price - 0.25 * atr));
      expect(s.reference_plan.sl).toBeCloseTo(expectedSl, 10);
      expect(s.reference_plan.tp1 - s.reference_plan.entry).toBeCloseTo(s.reference_plan.risk, 10);
      expect(s.reference_plan.tp2 - s.reference_plan.entry).toBeCloseTo(2 * s.reference_plan.risk, 10);
      expect(s.reference_plan).toMatchObject({ side: "BUY", rr_tp1: 1, rr_tp2: 2, anchor_kind: "CONFIRMED_H1_SWING_LOW" });
    }
  });
  it("H1 RSI14 direction gate is exact: BUY >50, SELL <50, 50/insufficient HOLD", () => {
    const valued = (value: number) => ({ status: "OK" as const, value, as_of_bar: 1 });
    expect(rsiDirectionGate("BUY", valued(50.01)).pass).toBe(true);
    expect(rsiDirectionGate("BUY", valued(50))).toEqual({ pass: false, reason: "H1_RSI14_NEUTRAL_50" });
    expect(rsiDirectionGate("BUY", valued(49.99)).reason).toBe("H1_RSI14_CONFLICTS_BUY");
    expect(rsiDirectionGate("SELL", valued(49.99)).pass).toBe(true);
    expect(rsiDirectionGate("SELL", valued(50.01)).reason).toBe("H1_RSI14_CONFLICTS_SELL");
    expect(rsiDirectionGate("SELL", { status: "INSUFFICIENT_HISTORY", required: 15, have: 14 }).pass).toBe(false);
  });
  it("reference plan refuses missing swings, invalid ATR, and non-positive risk", () => {
    const s = evaluate(base());
    const evidence = s.evidence!;
    expect(deriveReferencePlan(s.entry, s.quote, { ...evidence, H1: { ...evidence.H1, structure: { swings: [], latest_high: null, latest_low: null, summary: "INSUFFICIENT_HISTORY" } } })).toMatchObject({ status: "NOT_AVAILABLE", reason: "CONFIRMED_H1_SWING_LOW_UNAVAILABLE" });
    expect(deriveReferencePlan(s.entry, s.quote, { ...evidence, M15: { ...evidence.M15, atr14: { status: "INSUFFICIENT_HISTORY", required: 15, have: 1 } } })).toMatchObject({ status: "NOT_AVAILABLE", reason: "ATR14_M15_UNAVAILABLE" });
    const highAnchor = { ...evidence.H1.structure.swings[0]!, kind: "LOW" as const, price: s.quote!.ask + 10 };
    expect(deriveReferencePlan(s.entry, s.quote, { ...evidence, H1: { ...evidence.H1, structure: { ...evidence.H1.structure, swings: [highAnchor] } } })).toMatchObject({ status: "NOT_AVAILABLE", reason: "REFERENCE_PLAN_NON_POSITIVE_RISK" });
  });
  it("SELL plan uses BID, latest confirmed H1 high + 0.25×ATR14(M15), then 1R/2R below entry", () => {
    const s = evaluate(base());
    const evidence = s.evidence!;
    const latestHigh = [...evidence.H1.structure.swings].reverse().find((swing) => swing.kind === "HIGH")!;
    const atr = (evidence.M15.atr14 as { status: "OK"; value: number }).value;
    const quote = { ...s.quote!, bid: latestHigh.price - 5, ask: latestHigh.price - 4.8 };
    const plan = deriveReferencePlan({ state: "SHORT_CANDIDATE", reason: "TEST" }, quote, evidence);
    expect(plan.status).toBe("AVAILABLE");
    if (plan.status === "AVAILABLE") {
      expect(plan.entry).toBe(quote.bid);
      expect(plan.sl).toBeCloseTo(latestHigh.price + 0.25 * atr, 10);
      expect(plan.entry - plan.tp1).toBeCloseTo(plan.risk, 10);
      expect(plan.entry - plan.tp2).toBeCloseTo(2 * plan.risk, 10);
      expect(plan).toMatchObject({ side: "SELL", rr_tp1: 1, rr_tp2: 2, anchor_kind: "CONFIRMED_H1_SWING_HIGH" });
    }
  });
  it("forming M5 candle cannot create a CLOSED-only trigger (only CLOSED bars are inputs)", () => {
    const closed = bullEngulfM5().slice(0, -1); // engulfing bar is still FORMING → excluded
    const s = evaluate(base({ closed: { ...base().closed, M5: closed } }));
    expect(s.signal.state).toBe("WAITING");
  });
  it("closed candle is not mutated by evaluation/telemetry", () => {
    const i = base(); const before = JSON.stringify(i.closed.M5); evaluate(i); expect(JSON.stringify(i.closed.M5)).toBe(before);
  });
  it("execution/spread changes do not mutate setup", () => {
    const a = evaluate(base()), b = evaluate(base({ quote: { ...base().quote!, spread: 5 }, env: { operating_mode: "DEMO", execution_enabled: true } }));
    expect(b.setup).toEqual(a.setup);
    expect(b.execution.state).toBe("ALLOWED");
  });
  it("last-known snapshot cannot be labelled CURRENT", () => { expect(asLastKnown(evaluate(base())).label).toBe("LAST_KNOWN_STALE"); });
  it("transitions preserve reason/time/evidence/versions; trail bounded", () => {
    const t = new TransitionTrail(3); const a = evaluate(base()); t.record(null, a); const out = t.record(a, un);
    const sig = out.find((x) => x.domain === "SIGNAL")!;
    expect(sig).toMatchObject({ from: "READY", to: "NOT_EVALUABLE", reason_code: "MARKET_STATE_UNAVAILABLE", signal_policy_version: "signal-v2-operator-closed-m5-m15-patterns" });
    expect(t.entries.length).toBe(3); expect(t.total).toBe(9);
  });
});


// Canonical reader double: same MarketRuntimeReader contract the D2 MarketRuntime exposes.
function canonical(st: { lifecycle: MarketRuntimeSnapshot["lifecycle"]; boot: MarketRuntimeSnapshot["bootstrap_state"]; seq: number; formingClose?: number }) {
  const mk = (tf: Timeframe, closes: number[]): Bar[] => series(tf, closes).map((b) => ({ ...b, symbol: "XAUUSD", timeframe: tf, source: "EXNESS_MT5", status: "CLOSED", closed_at: b.close_time, effective_at: b.close_time - 1, tick_count: 3, revision: 0 }));
  const closed = { M5: mk("M5", up(40)), M15: mk("M15", up(40)), H1: mk("H1", up(40)), H4: mk("H4", up(40)) } as Record<Timeframe, Bar[]>;
  const forming = (tf: Timeframe): Bar => ({ ...closed[tf][closed[tf].length - 1]!, status: "FORMING", closed_at: null, open_time: 2e12, close_time: 2e12 + 1, close: st.formingClose ?? 999, high: 9999, low: 0 });
  const r: MarketRuntimeReader = {
    symbol: "XAUUSD", now: () => 1e13,
    closedBars: (tf) => closed[tf], formingBar: forming, missingIntervals: () => [],
    latestLiveObservation: () => (st.seq === 0 ? null : { seq: st.seq, symbol: "XAUUSD", source: "EXNESS_MT5", bid: 100, ask: 100.2, spread: 0.2, event_at: 5, observed_at: 6, ingested_at: 7, provenance: {} as never }),
    snapshot: () => ({ kind: "CANONICAL_MARKET_RUNTIME", operating_mode: "MONITOR_ONLY", execution_enabled: false, symbol: "XAUUSD", lifecycle: st.lifecycle, bootstrap_state: st.boot, active_epoch: 1, degraded_reason: st.boot === "DEGRADED" ? "history failed" : null, history_coverage_status: "PARTIAL", market_coverage_proven_complete: false, route_counts: { LIVE_MUTATION: st.seq, BACKFILL_HISTORY: 4, RECONCILIATION_CANDIDATE: 1, QUARANTINED: 0, REJECTED: 0 }, held: [], silent_ambiguous_drops: 0, stream_protocol_errors: 0, last_stream_error: null, timeframes: {} as never }),
  };
  return { r, closed };
}

describe("canonical unification — TechnicalSliceService consumes MarketRuntimeReader only", () => {
  const live = () => ({ lifecycle: "RUNNING" as const, boot: "SYNCHRONIZED" as const, seq: 1 });
  it("A/C: technical evidence comes from canonical CandleStore CLOSED bars; C1/bootstrap state visible", () => {
    const { r, closed } = canonical(live()); const svc = new TechnicalSliceService(r, "XAUUSD", new ReplayClock(1e13));
    const s = svc.tick();
    expect(s.availability).toBe("AVAILABLE"); expect(s.evidence!.M5.closed_count).toBe(closed.M5.length);
    expect(s.evidence!.H4.last_closed_open_time).toBe(closed.H4[closed.H4.length - 1]!.open_time);
    expect(svc.view()).toMatchObject({ data_source: "CANONICAL_MARKET_RUNTIME", canonical: { bootstrap_state: "SYNCHRONIZED", silent_ambiguous_drops: 0, route_counts: { RECONCILIATION_CANDIDATE: 1 }, missing_intervals: { M5: 0 } } });
  });
  it("B: service has no gateway/getBars/REST path and keeps no own candle array", () => {
    const src = readFileSync("src/core/technical/TechnicalSliceService.ts", "utf8");
    expect(src).not.toMatch(/getBars|getLatestTick|BrokerGatewayClient|gateway\/types|refreshBars|items\.slice\(0, -1\)|private closed/);
    expect(readFileSync("src/components/TechnicalSlicePanel.tsx", "utf8")).not.toMatch(/getBars|refreshBars|SliceGatewayPort/);
    expect(readFileSync("src/routes/index.tsx", "utf8")).not.toMatch(/TechnicalSlicePanel client=/);
  });
  it("D: FORMING canonical bar never reaches technical evidence / trigger", () => {
    const a = new TechnicalSliceService(canonical({ ...live(), formingClose: 1 }).r, "XAUUSD", new ReplayClock(1e13)).tick();
    const b = new TechnicalSliceService(canonical({ ...live(), formingClose: 5000 }).r, "XAUUSD", new ReplayClock(1e13)).tick();
    expect(a.evidence).toEqual(b.evidence); expect(a.last3_m5).toEqual(b.last3_m5);
    expect(a.last3_m5.every((g) => g.bar.open_time < 2e12)).toBe(true);
  });
  it("D2: bars not yet available_at T are excluded", () => {
    const { r, closed } = canonical(live()); const T = closed.M5[10]!.available_at;
    expect(new TechnicalSliceService(r, "XAUUSD", new ReplayClock(T)).tick().evidence!.M5.closed_count).toBe(11);
  });
  it("E: unmounted / DEGRADED / bootstrapping canonical runtime ⇒ NOT_EVALUABLE + BLOCKED", () => {
    const none = new TechnicalSliceService(null, "XAUUSD", new ReplayClock(1), "CANONICAL_RUNTIME_NOT_MOUNTED: test");
    for (const s of [none.tick(), ...(["DEGRADED", "BUFFERING_LIVE"] as const).map((b) => new TechnicalSliceService(canonical({ ...live(), boot: b as never }).r, "XAUUSD", new ReplayClock(1e13)).tick())]) {
      expect(s).toMatchObject({ availability: "UNAVAILABLE", bias: { state: "NOT_EVALUABLE" }, setup: { state: "NOT_EVALUABLE" }, signal: { state: "NOT_EVALUABLE" }, execution: { state: "BLOCKED" }, quote: null });
    }
    expect(none.view()).toMatchObject({ data_source: "CANONICAL_RUNTIME_NOT_MOUNTED", last_error: "CANONICAL_RUNTIME_NOT_MOUNTED: test" });
  });
  it("F: stopped runtime or no new LIVE_MUTATION cannot stay AVAILABLE; last known shown STALE; recovery", () => {
    const st = live(); const svc = new TechnicalSliceService(canonical(st).r, "XAUUSD", new ReplayClock(1e13));
    expect(svc.tick().availability).toBe("AVAILABLE");
    expect(svc.tick().availability).toBe("UNAVAILABLE"); // same seq: connected-but-silent ≠ AVAILABLE
    expect(svc.view().last_known!.label).toBe("LAST_KNOWN_STALE");
    const st2 = { ...live(), seq: 2, lifecycle: "STOPPED" as const }; const svc2 = new TechnicalSliceService(canonical(st2).r, "XAUUSD", new ReplayClock(1e13));
    expect(svc2.tick().availability).toBe("UNAVAILABLE");
  });
  it("G: technical formulas unchanged for equivalent canonical input", () => {
    const { r, closed } = canonical(live()); const s = new TechnicalSliceService(r, "XAUUSD", new ReplayClock(1e13)).tick();
    const direct = evaluate({ symbol: "XAUUSD", market_current: true, bars_current: true, quote: s.quote, as_of: 1e13, env: { operating_mode: "MONITOR_ONLY", execution_enabled: false },
      closed: { M5: closed.M5.map(toTechBar), M15: closed.M15.map(toTechBar), H1: closed.H1.map(toTechBar), H4: closed.H4.map(toTechBar) } });
    expect(s.evidence).toEqual(direct.evidence); expect(s.bias).toEqual(direct.bias); expect(s.setup).toEqual(direct.setup);
  });
  it("H/I/J: no mock fallback; /audit stays raw diagnostic; execution impossible", () => {
    const files = ["src/core/technical/indicators.ts", "src/core/technical/tradingState.ts", "src/core/technical/TechnicalSliceService.ts", "src/components/TechnicalSlicePanel.tsx", "src/routes/index.tsx"];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/from\s+"[^"]*(mock|fixture|simulation|probe)[^"]*"|order_send\(|order_check\(/i);
    const walk = (d: string): string[] => readdirSync(d).flatMap((x) => { const p = join(d, x); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk("src/core/technical")) expect(readFileSync(f, "utf8")).not.toMatch(/from\s+"[^"]*probe/);
    expect(readFileSync("src/components/BrokerAuditTerminal.tsx", "utf8")).toMatch(/getBars/);
    expect(EXECUTION_ENABLED).toBe(false);
    const s = new TechnicalSliceService(canonical(live()).r, "XAUUSD", new ReplayClock(1e13)).tick();
    expect(s.execution.state).not.toBe("ALLOWED");
  });
});
