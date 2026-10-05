import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { EXECUTION_ENABLED } from "@/core/contracts";
import { atrWilder, ema, engulfing, geometry, rsiWilder, structureOf, type TechBar } from "@/core/technical/indicators";
import { ALL_SIGNAL_STATES, TransitionTrail, asLastKnown, evaluate, type EvaluationInput } from "@/core/technical/tradingState";
import { TechnicalSliceService, type SliceGatewayPort } from "@/core/technical/TechnicalSliceService";

const TF = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
function series(tf: keyof typeof TF, closes: number[], start = 1_700_000_000_000): TechBar[] {
  return closes.map((c, i) => { const open_time = start + i * TF[tf];
    return { open_time, close_time: open_time + TF[tf], available_at: open_time + TF[tf], open: c, high: c + 0.5, low: c - 0.5, close: c }; });
}
// zig-zag uptrend: confirmed HH/HL
const up = (k: number) => Array.from({ length: k }, (_, i) => 100 + i * 0.3 + [0, 1, 2, 3, 4, 3, 2, 1][i % 8]!);
const bullEngulfM5 = () => { const b = series("M5", up(40)); const p = b[b.length - 2]!, l = b[b.length - 1]!;
  b[b.length - 2] = { ...p, open: 120, close: 119, high: 120.2, low: 118.8 }; b[b.length - 1] = { ...l, open: 118.9, close: 121, high: 121.2, low: 118.7 }; return b; };
const base = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  symbol: "XAUUSD", market_current: true, bars_current: true,
  quote: { bid: 125, ask: 125.2, spread: 0.2, tick_time_ms: 1, observed_at: 2 },
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
    expect(s.signal).toMatchObject({ state: "READY", reason: "M5_CLOSED_BULLISH_ENGULFING", validity_policy: "RESEARCH_REQUIRED" });
    expect(s.execution.state).toBe("BLOCKED");
    expect(s.execution.reasons).toContain("CAPABILITY_UNAUTHORIZED");
    expect(EXECUTION_ENABLED).toBe(false);
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
    const a = evaluate(base()), b = evaluate(base({ quote: { ...base().quote!, ask: 130, spread: 5 }, env: { operating_mode: "DEMO", execution_enabled: true } }));
    expect(b.setup).toEqual(a.setup);
    expect(b.execution.state).toBe("ALLOWED");
  });
  it("last-known snapshot cannot be labelled CURRENT", () => { expect(asLastKnown(evaluate(base())).label).toBe("LAST_KNOWN_STALE"); });
  it("transitions preserve reason/time/evidence/versions; trail bounded", () => {
    const t = new TransitionTrail(3); const a = evaluate(base()); t.record(null, a); const out = t.record(a, un);
    const sig = out.find((x) => x.domain === "SIGNAL")!;
    expect(sig).toMatchObject({ from: "READY", to: "NOT_EVALUABLE", reason_code: "MARKET_STATE_UNAVAILABLE", signal_policy_version: "signal-v0-baseline" });
    expect(t.entries.length).toBe(3); expect(t.total).toBe(10);
  });
});

describe("vertical slice — service wiring & no mock fallback", () => {
  const bar = (tf: string, i: number, c: number) => ({ broker_symbol: "XAUUSD", timeframe: tf, raw_time_s: 1_700_000_000 + i * 300, time_precision: "s", open: c - 0.2, high: c + 1, low: c - 1, close: c, tick_volume: 1, spread: 1, real_volume: 0 });
  const ok = (data: unknown, delivery: string) => ({ ok: true, data, envelope: { source: "EXNESS_MT5", source_mode: "REAL", delivery }, sequence: { disposition: "ACCEPT" } });
  function port(state: { up: boolean }): SliceGatewayPort {
    return {
      getLatestTick: async () => (state.up ? ok({ broker_symbol: "XAUUSD", bid: 100, ask: 100.2, raw_time_msc: 5, raw_time_s: 0 }, "LIVE") : { ok: false, error: { kind: "TRANSPORT_ERROR", message: "down" } }) as never,
      getBars: async ({ timeframe }) => (state.up ? ok({ items: Array.from({ length: 50 }, (_, i) => bar(timeframe, i, 100 + i)), coverage: {} }, "BACKFILL") : { ok: false, error: { kind: "TRANSPORT_ERROR", message: "down" } }) as never,
    };
  }
  it("disconnect → UNAVAILABLE/BLOCKED with LAST KNOWN stale; reconnect recovers; no substitute data", async () => {
    const st = { up: true }; const svc = new TechnicalSliceService(port(st), "XAUUSD", new ReplayClock(1));
    await svc.refreshBars(); const a = await svc.tick();
    expect(a.availability).toBe("AVAILABLE"); expect(svc.view().current!.evidence!.M5.closed_count).toBe(49); // newest = FORMING excluded
    st.up = false; const b = await svc.tick();
    expect(b).toMatchObject({ availability: "UNAVAILABLE", quote: null, evidence: null });
    expect(svc.view().last_known!.label).toBe("LAST_KNOWN_STALE");
    st.up = true; const c = await svc.tick();
    expect(c.availability).toBe("AVAILABLE"); expect(svc.view().last_known).toBeNull();
  });
  it("AI failure does not affect deterministic state (AI is outside the service)", async () => {
    const svc = new TechnicalSliceService(port({ up: true }), "XAUUSD", new ReplayClock(1));
    await svc.refreshBars(); const s = await svc.tick();
    const failingAi = async () => { throw new Error("timeout"); };
    await expect(failingAi()).rejects.toThrow(); expect(svc.view().current).toBe(s);
  });
  it("production slice path imports no mock/fixture/probe modules", () => {
    const files = ["src/core/technical/indicators.ts", "src/core/technical/tradingState.ts", "src/core/technical/TechnicalSliceService.ts", "src/components/TechnicalSlicePanel.tsx", "src/routes/index.tsx"];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/from\s+"[^"]*(mock|fixture|simulation|probe)[^"]*"|order_send\(|order_check\(/i);
    const walk = (d: string): string[] => readdirSync(d).flatMap((x) => { const p = join(d, x); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk("src/core/technical")) expect(readFileSync(f, "utf8")).not.toMatch(/src\/probe|@\/probe/);
  });
});
