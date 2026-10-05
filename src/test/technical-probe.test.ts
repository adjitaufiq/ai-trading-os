import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXECUTION_ENABLED, OPERATING_MODE, TIMEFRAME_MS, type Timeframe } from "@/core/contracts";
import { CandleAggregator } from "@/core/temporal/CandleAggregator";
import { ReplayClock } from "@/core/temporal/CanonicalClock";
import { compareBars, toBrokerObservedBar, toInternalAggregatedBar } from "@/core/candles/BarSchemas";
import type { BridgeBar } from "@/core/broker/bridge/types";
import { atr, ema, trueRange } from "@/probe/technical/indicators";
import { fromBrokerBars, fromInternalBars, prepareSeries } from "@/probe/technical/inputs";
import { auditLookahead, causalSwings, retrospectiveSwings } from "@/probe/technical/swing";
import { captureRealBackfill, prefixViolations, probeCaptured, recordFixture, runSeriesProbe } from "@/probe/technical/probe";
import { RETROSPECTIVE_REFERENCE, type ProbeBar } from "@/probe/technical/types";

const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
type O = { o?: number; h: number; l: number; c: number };
function bars(rows: (number | O)[], tf: Timeframe = "M5", opts: { skip?: number[]; lag?: number; symbol?: string; start?: number } = {}): ProbeBar[] {
  const step = TIMEFRAME_MS[tf];
  let slot = 0;
  return rows.map((r) => {
    while (opts.skip?.includes(slot)) slot++;
    const open_time = (opts.start ?? T0) + slot++ * step;
    const x = typeof r === "number" ? { o: r, h: r + 1, l: r - 1, c: r } : r;
    const close_time = open_time + step;
    return { symbol: opts.symbol ?? "XAUUSD", timeframe: tf, origin: "FIXTURE", open_time, close_time, lifecycle: "CLOSED",
      closed_at: close_time, available_at: close_time + (opts.lag ?? 0), open: x.o ?? x.c, high: x.h, low: x.l, close: x.c } as ProbeBar;
  });
}
const closes = (n: number, f = (i: number) => 100 + i) => Array.from({ length: n }, (_, i) => f(i));
const vals = (p: { value: number | null }[]) => p.map((x) => x.value);
const forming = (b: ProbeBar, c: number): ProbeBar => ({ ...b, open_time: b.close_time, close_time: b.close_time + (b.close_time - b.open_time), lifecycle: "FORMING", closed_at: null, available_at: null, high: c + 50, low: c - 50, close: c, open: c });
const swingRows: O[] = [10, 11, 15, 12, 11, 9, 5, 8, 9, 13, 14].map((h) => ({ h, l: h - 2, c: h - 1 }));

describe("Technical Validation Probe v1a — EMA", () => {
  const b = bars(closes(30, (i) => 100 + ((i * 7) % 11)));
  it("1 EMA5 seed = SMA of first 5 closes", () => {
    const e = ema(b, 5, "M5");
    expect(e[4]!.value).toBeCloseTo(b.slice(0, 5).reduce((s, x) => s + x.close, 0) / 5, 12);
  });
  it("2 EMA21 seed = SMA of first 21 closes", () => {
    expect(ema(b, 21, "M5")[20]!.value).toBeCloseTo(b.slice(0, 21).reduce((s, x) => s + x.close, 0) / 21, 12);
  });
  it("3 EMA recursion matches locked formula", () => {
    const e = ema(b, 5, "M5"), a = 2 / 6;
    for (let i = 5; i < b.length; i++) expect(e[i]!.value).toBeCloseTo(a * b[i]!.close + (1 - a) * e[i - 1]!.value!, 12);
  });
  it("4 warmup explicit; no seed from first price", () => {
    const e = ema(b.slice(0, 4), 5, "M5");
    expect(e.every((p) => p.status === "WARMUP_UNSATISFIED" && p.value === null && p.continuity === "WARMUP_UNSATISFIED")).toBe(true);
    expect(ema(b.slice(0, 20), 21, "M5").every((p) => p.value === null)).toBe(true);
  });
  it("5 FORMING candle cannot alter CLOSED-only EMA", () => {
    const base = runSeriesProbe({ symbol: "XAUUSD", timeframe: "M5", source_mode: "DETERMINISTIC_FIXTURE", temporal_policy: "FIXTURE_DECLARED", bars: b, detected_at: 0 });
    const withF = runSeriesProbe({ symbol: "XAUUSD", timeframe: "M5", source_mode: "DETERMINISTIC_FIXTURE", temporal_policy: "FIXTURE_DECLARED", bars: [...b, forming(b[b.length - 1]!, 999)], detected_at: 0 });
    expect(JSON.stringify(withF.ema5.result)).toBe(JSON.stringify(base.ema5.result));
    expect(JSON.stringify(withF.ema21.result)).toBe(JSON.stringify(base.ema21.result));
    expect(withF.summary.excluded_forming).toBe(1);
  });
  it("6 missing interval creates no synthetic EMA input, only a discontinuity flag", () => {
    const g = bars(closes(10), "M5", { skip: [6] });
    const e = ema(g, 5, "M5");
    expect(e).toHaveLength(10);
    expect(e[5]!.continuity).toBe("CONTINUOUS");
    expect(e[6]!.continuity).toBe("DISCONTINUOUS_MISSING_INTERVAL");
    expect(prepareSeries(g, "XAUUSD", "M5").gaps).toEqual([{ after_open_time: g[5]!.open_time, next_open_time: g[6]!.open_time, missing_count: 1 }]);
  });
});

describe("ATR", () => {
  const b = bars(closes(25, (i) => 100 + ((i * 5) % 9)).map((c, i) => ({ h: c + 1 + (i % 3), l: c - 1, c })));
  it("7 TR formula exact", () => {
    const t = trueRange(b, "M5"), i = 3, pc = b[2]!.close;
    expect(t[i]!.tr).toBe(Math.max(b[i]!.high - b[i]!.low, Math.abs(b[i]!.high - pc), Math.abs(b[i]!.low - pc)));
  });
  it("8 first bar has no previous close — explicit, not invented", () => {
    expect(trueRange(b, "M5")[0]).toMatchObject({ tr: null, status: "NO_PREVIOUS_CLOSE" });
  });
  it("9 initial ATR = SMA of TR[1..14] at bar index 14", () => {
    const t = trueRange(b, "M5"), a = atr(b, 14, "M5");
    expect(a[13]!.value).toBeNull();
    expect(a[14]!.value).toBeCloseTo(t.slice(1, 15).reduce((s, x) => s + x.tr!, 0) / 14, 12);
  });
  it("10 subsequent ATR is Wilder/RMA", () => {
    const t = trueRange(b, "M5"), a = atr(b, 14, "M5");
    for (let i = 15; i < b.length; i++) expect(a[i]!.value).toBeCloseTo((a[i - 1]!.value! * 13 + t[i]!.tr!) / 14, 12);
  });
  it("11 ATR warmup explicit", () => {
    expect(atr(b.slice(0, 14), 14, "M5").every((p) => p.status === "WARMUP_UNSATISFIED")).toBe(true);
  });
  it("12 FORMING candle cannot alter ATR", () => {
    const p = (x: ProbeBar[]) => JSON.stringify(runSeriesProbe({ symbol: "XAUUSD", timeframe: "M5", source_mode: "DETERMINISTIC_FIXTURE", temporal_policy: "FIXTURE_DECLARED", bars: x, detected_at: 0 }).atr14.result);
    expect(p([...b, forming(b[24]!, 5000)])).toBe(p(b));
  });
  it("13 missing interval creates no fake TR; previous close across gap is flagged", () => {
    const g = bars(closes(6), "M5", { skip: [3] });
    const t = trueRange(g, "M5");
    expect(t).toHaveLength(6);
    expect(t[3]!.previous_close_across_gap).toBe(true);
  });
});

describe("Swing comparator", () => {
  const b = bars(swingRows);
  it("14/15/16 retrospective uses right-side bars, labeled, no authority", () => {
    const r = retrospectiveSwings(b, "M5");
    const hi = r.find((s) => s.type === "SWING_HIGH")!;
    expect(hi.event_at).toBe(b[2]!.open_time);
    expect(hi.right_dependency_open_times).toEqual([b[3]!.open_time, b[4]!.open_time]);
    expect(r.every((s) => s.mode === "RETROSPECTIVE_LOOKAHEAD" && s.trading_authority === "NONE" && s.live_safe === false)).toBe(true);
  });
  it("17/18/19/20 causal: event_at = T, available_at from actual confirmation evidence", () => {
    const lag = bars(swingRows, "M5", { lag: 1234 });
    const c = causalSwings(lag, "M5").swings.find((s) => s.type === "SWING_HIGH")!;
    expect(c.event_at).toBe(lag[2]!.open_time);
    expect(c.confirmation_open_time).toBe(lag[4]!.open_time);
    expect(c.available_at).toBe(lag[4]!.available_at);
    expect(c.available_at).toBeGreaterThanOrEqual(c.confirmation_closed_at);
    expect(c.available_at).toBeGreaterThanOrEqual(c.confirmation_available_at);
  });
  it("21 gap between candidate and confirmation: no T+N×TF arithmetic", () => {
    const g = bars(swingRows, "M5", { skip: [3, 4, 5] });
    const c = causalSwings(g, "M5").swings.find((s) => s.type === "SWING_HIGH")!;
    const arithmetic = c.event_at + 3 * TIMEFRAME_MS.M5;
    expect(c.available_at).toBe(g[4]!.closed_at);
    expect(c.available_at).not.toBe(arithmetic);
    expect(c.window_spans_missing_interval).toBe(true);
  });
  it("22 FORMING confirmation cannot confirm", () => {
    const x = [...b.slice(0, 4), { ...b[4]!, lifecycle: "FORMING", closed_at: null, available_at: null } as ProbeBar];
    const s = prepareSeries(x, "XAUUSD", "M5");
    expect(causalSwings(s.bars, "M5").swings).toHaveLength(0);
  });
  it("23 insufficient history → WARMUP_UNSATISFIED", () => {
    expect(causalSwings(b.slice(0, 4), "M5").status).toBe("WARMUP_UNSATISFIED");
  });
  it("24 tie policy deterministic: equal highs reject", () => {
    const t = bars([{ h: 10, l: 8, c: 9 }, { h: 11, l: 8, c: 9 }, { h: 12, l: 8, c: 9 }, { h: 12, l: 8, c: 9 }, { h: 10, l: 8, c: 9 }, { h: 9, l: 8, c: 9 }]);
    expect(retrospectiveSwings(t, "M5").filter((s) => s.type === "SWING_HIGH")).toHaveLength(0);
    expect(causalSwings(t, "M5").swings.filter((s) => s.type === "SWING_HIGH")).toHaveLength(0);
  });
});

describe("Temporal / replay", () => {
  const b = bars(closes(60, (i) => 100 + Math.round(10 * Math.sin(i / 3))).map((c, i) => ({ h: c + 1 + (i % 4), l: c - 1 - (i % 3), c })));
  it("25 same input twice → identical serialized diagnostics", () => {
    const run = () => JSON.stringify(runSeriesProbe({ symbol: "XAUUSD", timeframe: "M5", source_mode: "DETERMINISTIC_FIXTURE", temporal_policy: "FIXTURE_DECLARED", bars: b, detected_at: 42 }));
    expect(run()).toBe(run());
  });
  it("26 probe source has no Date.now / Math.random", () => {
    for (const f of ["types", "inputs", "indicators", "swing", "probe"]) {
      const src = readFileSync(`src/probe/technical/${f}.ts`, "utf8");
      expect(src).not.toMatch(/Date\.now|Math\.random|new Date\(/);
    }
  });
  it("27/28/29 prefix runs never rewrite already-available EMA/ATR/causal swing", () => {
    expect(prefixViolations(b, "M5")).toEqual([]);
    expect(prefixViolations(bars(swingRows), "M5")).toEqual([]);
  });
  it("30 retrospective future dependency → LOOKAHEAD_DETECTED", () => {
    const a = auditLookahead(bars(swingRows), "M5");
    expect(a.status).toBe("LOOKAHEAD_DETECTED");
    expect(a.items.every((x) => !x.visible_with_prefix_ending_at_event && x.knowledge_delay_ms > 0)).toBe(true);
  });
  it("causal swing at asOf: unknown before confirmation availability", () => {
    const x = bars(swingRows);
    expect(causalSwings(x, "M5", 2, 2, x[3]!.available_at!).swings.some((s) => s.event_at === x[2]!.open_time)).toBe(false);
    expect(causalSwings(x, "M5", 2, 2, x[4]!.available_at!).swings.some((s) => s.event_at === x[2]!.open_time)).toBe(true);
  });
});

describe("MTF isolation", () => {
  const all = (["M5", "M15", "H1", "H4"] as const).flatMap((tf, k) => bars(closes(30, (i) => 100 * (k + 1) + i), tf));
  it.each(["M5", "M15", "H1", "H4"] as const)("31-34 %s consumes only its own bars", (tf) => {
    const r = runSeriesProbe({ symbol: "XAUUSD", timeframe: tf, source_mode: "DETERMINISTIC_FIXTURE", temporal_policy: "FIXTURE_DECLARED", bars: all, detected_at: 0 });
    expect(r.summary.usable_closed).toBe(30);
    expect(r.summary.excluded_foreign).toBe(90);
    expect(r.ema5.result.every((p) => p.open_time % TIMEFRAME_MS[tf] === 0)).toBe(true);
  });
  it("35 no cross-timeframe contamination", () => {
    const run = (tf: Timeframe, src: ProbeBar[]) => JSON.stringify(runSeriesProbe({ symbol: "XAUUSD", timeframe: tf, source_mode: "DETERMINISTIC_FIXTURE", temporal_policy: "FIXTURE_DECLARED", bars: src, detected_at: 0 }).ema21);
    expect(run("H1", all)).toBe(run("H1", all.filter((b) => b.timeframe === "H1")));
    expect(run("H4", all)).toBe(run("H4", [...all].reverse()));
  });
});

describe("R8 / bar semantics (replay through existing CandleAggregator)", () => {
  const clock = new ReplayClock(T0);
  const agg = new CandleAggregator("XAUUSD", "M5", clock);
  const prices = [100, 101, 99, 100.5, 102, 101.5];
  prices.forEach((p, i) => {
    const t = T0 + i * 100_000; // 6 ticks over two M5 intervals
    clock.advanceTo(t);
    agg.ingest({ seq: i, symbol: "XAUUSD", source: "REPLAY_FIXTURE", bid: p, ask: p + 0.2, spread: 0.2, event_at: t, observed_at: t, ingested_at: t });
  });
  clock.advanceTo(T0 + 2 * TIMEFRAME_MS.M5); agg.checkBoundary();
  const internal = fromInternalBars(agg.closedBars);
  const raw: BridgeBar = { broker_symbol: "XAUUSD", timeframe: "M5", raw_time_s: T0 / 1000, time_precision: "s", open: 100, high: 101, low: 99, close: 99, tick_volume: 777, spread: 20, real_volume: 0 };
  it("36 broker bar and replay bar stay distinct types", () => {
    expect(internal[0]!.origin).toBe("INTERNAL_REPLAY");
    expect(fromBrokerBars([raw], { newestMayBeForming: false })[0]!.origin).toBe("BROKER_OBSERVED");
  });
  it("37/38 tick count not equated to tick_volume; real_volume not inferred", () => {
    const prov = { raw_event_id: "x", source: "EXNESS_MT5", symbol: "XAUUSD", received_at: T0, normalizer_version: "t", connection_epoch: 1, delivery: "BACKFILL" } as const;
    const d = compareBars(toInternalAggregatedBar(agg.closedBars[0]!), toBrokerObservedBar({ symbol: "XAUUSD", timeframe: "M5", open_time: T0, open: 100, high: 101, low: 99, close: 99, tick_volume: 777, real_volume: null, observed_at: T0, provenance: prov as never }),
      { symbol: "XAUUSD", digits: 2, point: 0.01 } as never, { maxPriceDeltaPoints: 0 });
    expect(d.volume.comparison).toBe("NOT_COMPARED_NO_EQUIVALENCE");
    expect(d.volume.internal_observed_tick_count).toBe(3);
    expect(d.volume.broker_tick_volume).toBe(777);
    expect(d.volume.broker_real_volume).toBeNull();
  });
  it("39 probe does not use legacy verifyBar", () => {
    for (const f of ["inputs", "indicators", "swing", "probe"]) expect(readFileSync(`src/probe/technical/${f}.ts`, "utf8")).not.toMatch(/verifyBar|DiscrepancyVerifier/);
  });
  it("newest bar of a pos=0 broker request is treated as FORMING", () => {
    const p = fromBrokerBars([raw, { ...raw, raw_time_s: raw.raw_time_s + 300 }], { newestMayBeForming: true });
    expect(p.map((x) => x.lifecycle)).toEqual(["CLOSED", "FORMING"]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

describe("Safety / isolation", () => {
  it("40 production modules never import src/probe", () => {
    const prod = [...walk("src/core"), ...walk("src/components"), ...walk("src/routes"), "src/router.tsx", "src/start.ts", "src/server.ts"].filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of prod) expect(readFileSync(f, "utf8"), f).not.toMatch(/probe\//);
  });
  it("41-43 probe has no EvidenceState/decision/signal/execution surface", () => {
    for (const f of walk("src/probe").filter((x) => x.endsWith(".ts"))) {
      const s = readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(s).not.toMatch(/EvidenceState|StrategyDecision|SetupState|SignalState|order_send|order_check|\bBUY\b|\bSELL\b/);
    }
    const r = runSeriesProbe({ symbol: "XAUUSD", timeframe: "M5", source_mode: "DETERMINISTIC_FIXTURE", temporal_policy: "FIXTURE_DECLARED", bars: bars(swingRows), detected_at: 0 });
    for (const e of [r.ema5, r.ema21, r.atr14, r.swingCausal, r.swingRetrospective, r.lookahead]) expect(e).toMatchObject({ kind: "DIAGNOSTIC_PROBE", authority: "NONE" });
  });
  it("44/45 MONITOR_ONLY and execution disabled", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
  });
  it("retrospective provenance does not invent a commit", () => {
    expect(RETROSPECTIVE_REFERENCE.reference_commit).toBe("UNVERIFIED");
  });
});

describe("Real data labeling (no network)", () => {
  const raw = (i: number): BridgeBar => ({ broker_symbol: "XAUUSD", timeframe: "M5", raw_time_s: T0 / 1000 + i * 300, time_precision: "s", open: 1, high: 2, low: 0.5, close: 1.5, tick_volume: 3, spread: 1, real_volume: 0 });
  const okClient = {
    getBars: async (q: { symbol: string; timeframe: Timeframe }) => ({
      ok: true, data: { items: [0, 1, 2].map((i) => ({ ...raw(i), broker_symbol: q.symbol, timeframe: q.timeframe })), coverage: {} },
      envelope: { source: "EXNESS_MT5", source_mode: "REAL", delivery: "BACKFILL", bridge_instance_id: "b", connection_epoch: 1, request_id: "r", timing: { bridge_sent_at: 5 } },
      sequence: { disposition: "ACCEPT", observations: [] },
    }),
  };
  it("46 actually fetched REAL is labeled REAL / REAL_LIVE_FETCH", async () => {
    const c = await captureRealBackfill(okClient as never, 3);
    expect(c.status).toBe("AVAILABLE");
    expect(probeCaptured(c.series[0]!, "REAL_LIVE_FETCH", 0).summary.source_mode).toBe("REAL_LIVE_FETCH");
  });
  it("47 recorded fixture is RECORDED_REPLAY", async () => {
    const f = recordFixture((await captureRealBackfill(okClient as never, 3)).series);
    expect(f.source_mode).toBe("RECORDED_REPLAY");
    expect(probeCaptured(f.series[0]!, "RECORDED_REPLAY", 0).summary.source_mode).toBe("RECORDED_REPLAY");
    expect(JSON.stringify(f)).not.toMatch(/password|login|token|secret/i);
  });
  it("48 gateway unavailable → UNAVAILABLE, no mock fallback", async () => {
    const down = { getBars: async () => ({ ok: false, error: { kind: "TRANSPORT_ERROR", message: "down" }, sequence: null }) };
    const c = await captureRealBackfill(down as never, 3);
    expect(c.status).toBe("UNAVAILABLE");
    expect(c.series.every((s) => s.status === "UNAVAILABLE" && s.items.length === 0)).toBe(true);
    const sim = { getBars: async (q: never) => { const r = await okClient.getBars(q); return { ...r, envelope: { ...r.envelope, source_mode: "SIMULATION" } }; } };
    expect((await captureRealBackfill(sim as never, 3)).status).toBe("UNAVAILABLE");
  });
});
