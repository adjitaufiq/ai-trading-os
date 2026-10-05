// TECHNICAL VALIDATION PROBE v1c — BASE TECHNICAL STATE. DIAGNOSTIC_PROBE / authority NONE. Not Stage 4.
// Primary integration input: MarketRuntimeReader canonical CLOSED candles produced by the D2 application chain
// (real BrokerGatewayClient over a hermetic transport). No primitive arrays are fed directly in integration tests.
// REAL_DATA_VALIDATION = UNAVAILABLE: no broker is contacted; fixtures are never presented as real data.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, type Timeframe } from "@/core/contracts";
import { ema } from "@/probe/technical/indicators";
import { fromInternalBars } from "@/probe/technical/inputs";
import {
  classifyStructure, emaRelation, formatReport, htfAlignment, technicalStateReport, timeframeState, trendStructureRelation,
  type TechnicalStateReport,
} from "@/probe/technical/technicalState";
import { bear, bull, feedHours, HOUR, makeRig, MIN, T0, type HourSpec } from "./helpers/v1cRig";

const json = (x: unknown) => JSON.stringify(x);
const lastC = (s: readonly HourSpec[]) => s[s.length - 1]!.c;
async function run(specs: readonly HourSpec[], opts: { skip?: Set<number>; symbol?: "XAUUSD" | "BTCUSD"; snapAt?: number[] } = {}) {
  const rig = makeRig(opts.symbol);
  await rig.start();
  const snaps = new Map<number, TechnicalStateReport>();
  feedHours(rig, 1, specs, 2000, opts.skip, (k) => { if (opts.snapAt?.includes(k)) snaps.set(k, technicalStateReport(rig.r)); });
  return { ...rig, snaps };
}
/** Would the EMA relation flip if the FORMING bar were (illegally) treated as closed? Proves the scenario is adversarial. */
function relationIncludingForming(r: ReturnType<typeof makeRig>["r"], tf: Timeframe) {
  const f = r.formingBar(tf)!;
  const bars = fromInternalBars([...r.closedBars(tf), { ...f, status: "CLOSED", closed_at: f.close_time, available_at: f.close_time }]);
  const e5 = ema(bars, 5, tf), e21 = ema(bars, 21, tf);
  return emaRelation(e5[e5.length - 1]!.value, e21[e21.length - 1]!.value);
}
const NO_SIGNAL = /"(buy|sell|long|short|entry|stop_loss|take_profit|position_size|risk_pct|signal|recommendation|decision)"/i;
const BULL = bull(100);

describe("v1c pure classification", () => {
  it("EMA relation: strict >, <, == ; null → INSUFFICIENT_DATA (no crossover required)", () => {
    expect(emaRelation(2, 1)).toBe("BULLISH");
    expect(emaRelation(1, 2)).toBe("BEARISH");
    expect(emaRelation(1, 1)).toBe("NEUTRAL");
    expect(emaRelation(null, 1)).toBe("INSUFFICIENT_DATA");
  });
  it("structure + trend/structure relation: no vote counting, conflict is explicit", () => {
    expect(classifyStructure("HH", "HL")).toBe("BULLISH_STRUCTURE");
    expect(classifyStructure("LH", "LL")).toBe("BEARISH_STRUCTURE");
    expect(classifyStructure("LH", "HL")).toBe("MIXED_STRUCTURE");
    expect(classifyStructure(null, "HL")).toBe("INSUFFICIENT_STRUCTURE");
    expect(trendStructureRelation("BULLISH", "BEARISH_STRUCTURE")).toBe("CONFLICT");
    expect(trendStructureRelation("BULLISH", "MIXED_STRUCTURE")).toBe("CONFLICT");
    expect(trendStructureRelation("BULLISH", "BULLISH_STRUCTURE")).toBe("ALIGNED");
    expect(trendStructureRelation("NEUTRAL", "BULLISH_STRUCTURE")).toBe("UNKNOWN");
    expect(trendStructureRelation("BULLISH", "INSUFFICIENT_STRUCTURE")).toBe("UNKNOWN");
  });
});

describe("v1c adversarial MarketRuntime scenarios", () => {
  it("A. clean bull → BULLISH_ALIGNED; M15/M5 reported independently; no signal field", async () => {
    const x = await run(BULL);
    const rep = technicalStateReport(x.r);
    expect(rep.timeframes.H4.ema_relation).toBe("BULLISH");
    expect(rep.timeframes.H1.ema_relation).toBe("BULLISH");
    expect(rep.htf.alignment).toBe("BULLISH_ALIGNED");
    expect(rep.timeframes.H1.structure).toBe("BULLISH_STRUCTURE");
    expect(rep.timeframes.H1.trend_structure_relation).toBe("ALIGNED");
    for (const tf of ["M15", "M5"] as const) {
      expect(rep.timeframes[tf].timeframe).toBe(tf);
      expect(rep.timeframes[tf].history_status.closed_bars_used).toBeGreaterThan(rep.timeframes.H1.history_status.closed_bars_used);
    }
    expect(rep.kind).toBe("DIAGNOSTIC_PROBE");
    expect(rep.authority).toBe("NONE");
    expect(json(rep)).not.toMatch(NO_SIGNAL);
    console.log(`[v1c A]\n${formatReport(rep)}`);
  });

  it("B. clean bear → BEARISH_ALIGNED", async () => {
    const x = await run(bear(100, 2400));
    const rep = technicalStateReport(x.r);
    expect(rep.timeframes.H4.ema_relation).toBe("BEARISH");
    expect(rep.timeframes.H1.ema_relation).toBe("BEARISH");
    expect(rep.htf.alignment).toBe("BEARISH_ALIGNED");
    console.log(`[v1c B]\n${formatReport(rep)}`);
  });

  it("C. H4 bullish + H1 bearish → MIXED (no BUY/SELL)", async () => {
    const drop = Array.from({ length: 8 }, (_, i) => ({ c: +(lastC(BULL) - 3 * (i + 1)).toFixed(2) }));
    const x = await run([...BULL, ...drop]);
    const rep = technicalStateReport(x.r);
    expect(rep.timeframes.H4.ema_relation).toBe("BULLISH");
    expect(rep.timeframes.H1.ema_relation).toBe("BEARISH");
    expect(rep.htf.alignment).toBe("MIXED");
    expect(json(rep)).not.toMatch(NO_SIGNAL);
    console.log(`[v1c C]\n${formatReport(rep)}`);
  });

  it("D. required timeframe warmup-unsatisfied → INSUFFICIENT_DATA, never MIXED", async () => {
    // Runtime-reachable direction: early in the stream H1 is warm, H4 is not.
    const early = await run(bull(40));
    const e = technicalStateReport(early.r);
    expect(e.timeframes.H1.temporal_eligibility.eligible_for_alignment).toBe(true);
    expect(e.timeframes.H4.warmup.ema21).toBe("WARMUP_UNSATISFIED");
    expect(e.htf.alignment).toBe("INSUFFICIENT_DATA");
    // Literal D (H4 valid, H1 warmup-unsatisfied) is unreachable from ONE runtime (H1 always has ≥ H4 closed bars),
    // so it is evaluated by composing two genuine runtime states: H4 from a long run, H1 from a short run.
    const long = await run(BULL), short = await run(bull(10));
    const h4 = timeframeState(long.r, "H4", long.r.now()), h1 = timeframeState(short.r, "H1", short.r.now());
    expect(h4.temporal_eligibility.eligible_for_alignment).toBe(true);
    expect(h1.warmup.ema21).toBe("WARMUP_UNSATISFIED");
    const a = htfAlignment(h4, h1, long.r.now());
    expect(a.alignment).toBe("INSUFFICIENT_DATA");
    expect(a.insufficient_reasons).toContain("H1:EMA_WARMUP_UNSATISFIED");
  });

  it("E. forming H1 that would flip EMA → closed H1 relation and HTF unchanged", async () => {
    const x = await run(BULL);
    const before = technicalStateReport(x.r);
    const P = lastC(BULL);
    x.live({ ms: T0 + 101 * HOUR + 1 * MIN, bid: P });
    const settled = technicalStateReport(x.r); // hour 100 now CLOSED
    x.live({ ms: T0 + 101 * HOUR + 30 * MIN, bid: P - 80 });
    expect(relationIncludingForming(x.r, "H1")).toBe("BEARISH"); // adversarial: would flip if forming were used
    const after = technicalStateReport(x.r);
    expect(after.timeframes.H1.ema_relation).toBe("BULLISH");
    expect(json(after.timeframes.H1.provenance)).toBe(json(settled.timeframes.H1.provenance));
    expect(after.htf.alignment).toBe("BULLISH_ALIGNED");
    expect(before.htf.alignment).toBe("BULLISH_ALIGNED");
  });

  it("F. forming H4 that would flip trend → no premature HTF state change", async () => {
    const specs = bull(103);
    const x = await run(specs);
    const P = lastC(specs);
    x.live({ ms: T0 + 104 * HOUR + 1 * MIN, bid: P }); // closes H4 bar [100h,104h)
    const settled = technicalStateReport(x.r);
    x.live({ ms: T0 + 104 * HOUR + 20 * MIN, bid: P - 300 });
    expect(relationIncludingForming(x.r, "H4")).toBe("BEARISH");
    const after = technicalStateReport(x.r);
    expect(after.timeframes.H4.ema_relation).toBe("BULLISH");
    expect(json(after.timeframes.H4)).toBe(json({ ...settled.timeframes.H4, as_of: after.as_of }));
    expect(after.htf.alignment).toBe(settled.htf.alignment);
  });

  it("G. missing interval → no fabricated candle; discontinuity exposed; alignment INSUFFICIENT until window clears", async () => {
    const skip = new Set([60, 61, 62]);
    const x = await run(BULL, { skip, snapAt: [70] });
    const mid = x.snaps.get(70)!;
    for (const k of skip) expect(x.r.closedBars("H1").some((b) => b.open_time === T0 + k * HOUR)).toBe(false);
    expect(mid.timeframes.H1.missing_interval_status.count).toBeGreaterThan(0);
    expect(mid.timeframes.H1.missing_interval_status.inside_ema21_window).toBe(true);
    expect(mid.timeframes.H1.temporal_eligibility.reasons).toContain("MISSING_INTERVAL_INSIDE_EMA21_WINDOW");
    expect(mid.htf.alignment).toBe("INSUFFICIENT_DATA");
    const end = technicalStateReport(x.r);
    expect(end.timeframes.H1.missing_interval_status.count).toBeGreaterThan(0); // still reported
    expect(end.timeframes.H1.missing_interval_status.inside_ema21_window).toBe(false);
    expect(end.htf.alignment).toBe("BULLISH_ALIGNED");
    expect(end.temporal_warnings.some((w) => w.startsWith("H1:") && w.includes("no candle fabricated"))).toBe(true);
  });

  it("H. EMA bullish while confirmed causal structure deteriorates → explicit CONFLICT, no SELL", async () => {
    const P = lastC(BULL);
    // lower high / lower low progression, small amplitude relative to the EMA spread
    const det = [3, 6, 3, 1, 4, 2, -1, 2.5, 0.5, -2, 1, -0.5].map((d) => ({ c: +(P + d).toFixed(2) }));
    const x = await run([...BULL, ...det]);
    const s = technicalStateReport(x.r).timeframes.H1;
    expect(s.ema_relation).toBe("BULLISH");
    expect(s.structure).not.toBe("BULLISH_STRUCTURE");
    expect(s.trend_structure_relation).toBe("CONFLICT");
    expect(json(s)).not.toMatch(NO_SIGNAL);
    console.log(`[v1c H] H1 ema=${s.ema_relation} structure=${s.structure} (${s.high_progression}/${s.low_progression}) relation=${s.trend_structure_relation}`);
  });

  it("I. outside bar: both causal swing facts preserved in technical state", async () => {
    const P = lastC(BULL);
    const tail = [{ c: P + 1 }, { c: P + 2 }, { c: P + 2.5, w: 20 }, { c: P + 2 }, { c: P + 1.5 }, { c: P + 1.8 }];
    const x = await run([...BULL, ...tail]);
    const s = technicalStateReport(x.r).timeframes.H1;
    const outside = T0 + 103 * HOUR;
    expect(s.latest_causal_swing_high?.event_at).toBe(outside);
    expect(s.latest_causal_swing_low?.event_at).toBe(outside);
    expect(s.latest_causal_swing_high?.outside_bar).toBe(true);
    expect(s.latest_causal_swing_low?.outside_bar).toBe(true);
  });

  it("J. future append: historical snapshot at T is byte-equivalent after appending candles", async () => {
    const x = await run(BULL, { snapAt: [30, 60, 90] });
    for (const [, snap] of x.snaps) expect(json(technicalStateReport(x.r, snap.as_of))).toBe(json(snap));
  });

  it("K. replay determinism: identical fixture twice → identical candles and technical state", async () => {
    const a = await run(BULL, { symbol: "BTCUSD" }), b = await run(BULL, { symbol: "BTCUSD" });
    for (const tf of ["M5", "M15", "H1", "H4"] as const) expect(json(a.r.closedBars(tf))).toBe(json(b.r.closedBars(tf)));
    expect(json(technicalStateReport(a.r))).toBe(json(technicalStateReport(b.r)));
  });

  it("L. MTF isolation: altered M5 path with identical H1/H4 closed histories → H1/H4 state unchanged", async () => {
    const a = await run(BULL), b = await run(BULL.map((h, i) => ({ ...h, extra: i % 3 === 0 })));
    const ra = technicalStateReport(a.r), rb = technicalStateReport(b.r);
    expect(json(a.r.closedBars("M5"))).not.toBe(json(b.r.closedBars("M5")));
    expect(json(ra.timeframes.H1)).toBe(json(rb.timeframes.H1));
    expect(json(ra.timeframes.H4)).toBe(json(rb.timeframes.H4));
    expect(json(ra.htf)).toBe(json(rb.htf));
  });
});

describe("v1c diagnostic timeline — WHEN the system may change its mind", () => {
  it("INSUFFICIENT → H1 only → BULLISH_ALIGNED → forming H1 drop (no change) → H1 closes bearish → MIXED", async () => {
    const x = await run(BULL, { snapAt: [1, 30, 99] });
    const P = lastC(BULL);
    const rows: { label: string; rep: TechnicalStateReport }[] = [
      { label: "T0 first hour", rep: x.snaps.get(1)! },
      { label: "T1 H1 warm, H4 warming", rep: x.snaps.get(30)! },
      { label: "T2 both warm", rep: x.snaps.get(99)! },
    ];
    x.live({ ms: T0 + 101 * HOUR + 1 * MIN, bid: P });
    x.live({ ms: T0 + 101 * HOUR + 30 * MIN, bid: P - 80 });
    expect(relationIncludingForming(x.r, "H1")).toBe("BEARISH");
    rows.push({ label: "T3 forming H1 below EMA21", rep: technicalStateReport(x.r) });
    x.live({ ms: T0 + 101 * HOUR + 50 * MIN, bid: P - 80 });
    x.live({ ms: T0 + 102 * HOUR + 1 * MIN, bid: P - 80 }); // closes hour 101
    rows.push({ label: "T4 H1 closed bearish", rep: technicalStateReport(x.r) });
    const tl = rows.map((r) => `${r.label}: H4=${r.rep.timeframes.H4.ema_relation} H1=${r.rep.timeframes.H1.ema_relation} HTF=${r.rep.htf.alignment}`);
    console.log(`[v1c timeline]\n${tl.join("\n")}`);
    expect(rows.map((r) => r.rep.htf.alignment)).toEqual(["INSUFFICIENT_DATA", "INSUFFICIENT_DATA", "BULLISH_ALIGNED", "BULLISH_ALIGNED", "MIXED"]);
    expect(rows[0]!.rep.timeframes.H1.ema_relation).toBe("INSUFFICIENT_DATA");
    expect(rows[1]!.rep.timeframes.H1.ema_relation).toBe("BULLISH");
    expect(rows[1]!.rep.timeframes.H4.ema_relation).toBe("INSUFFICIENT_DATA");
    expect(rows[3]!.rep.timeframes.H1.history_status.forming_policy).toBe("FORMING_NEVER_CONSUMED");
    expect(rows[4]!.rep.timeframes.H1.ema_relation).toBe("BEARISH");
    expect(rows[4]!.rep.timeframes.H4.ema_relation).toBe("BULLISH");
  });
});

describe("v1c authority / safety", () => {
  it("MONITOR_ONLY, execution disabled, production never imports src/probe, probe has no execution surface", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk("src").filter((p) => !p.startsWith(join("src", "probe")) && !p.startsWith(join("src", "test")) && /\.(ts|tsx)$/.test(p))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from\s+["'](@\/probe|\.\.?\/.*probe\/)/);
    }
    const src = readFileSync("src/probe/technical/technicalState.ts", "utf8");
    expect(src).not.toMatch(/order_send|order_check|StrategyDecision/);
  });
});
