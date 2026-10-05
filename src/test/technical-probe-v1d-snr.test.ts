// TECHNICAL VALIDATION PROBE v1d-SNR — DIAGNOSTIC_PROBE / authority NONE. Not Stage 4.
// Input: MarketRuntimeReader CLOSED candles from the D2 application chain over a hermetic transport. REAL_DATA_VALIDATION = UNAVAILABLE.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE, type Timeframe } from "@/core/contracts";
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import { fromInternalBars, prepareSeries } from "@/probe/technical/inputs";
import { retrospectiveSwings } from "@/probe/technical/swing";
import type { ProbeBar } from "@/probe/technical/types";
import {
  exactPriceConfluences, factualSummary, interaction, InvalidUserLevelError, SNR_RESEARCH_REGISTER, snrReport,
  timeframeSnrState, userHorizontalLevel, type DerivedSnrCandidate, type SnrReport,
} from "@/probe/technical/snr";
import { feedHours, HOUR, makeRig, T0, type HourSpec } from "./helpers/v1cRig";

const json = (x: unknown) => JSON.stringify(x);
const NO_SIGNAL = /"(buy|sell|long|short|entry|stop_loss|take_profit|position_size|risk_pct|signal|recommendation|decision|breakout|fakeout|retest|role_reversal|strength|score|zone|tolerance)"/i;

function waves(turns: readonly number[], start = 2000): HourSpec[] {
  const out: HourSpec[] = [];
  let a = start;
  for (const b of turns) { for (let j = 1; j <= 3; j++) out.push({ c: +(a + ((b - a) * j) / 3).toFixed(2) }); a = b; }
  return out;
}
const turnHour = (i: number) => 3 * i + 3;
async function run(specs: readonly HourSpec[], o: { skip?: Set<number>; snapAt?: number[]; symbol?: "XAUUSD" | "BTCUSD" } = {}) {
  const rig = makeRig(o.symbol);
  await rig.start();
  const snaps = new Map<number, SnrReport>();
  feedHours(rig, 1, specs, 2000, o.skip, (k) => { if (o.snapAt?.includes(k)) snaps.set(k, snrReport(rig.r)); });
  return { ...rig, snaps };
}
const cand = (s: { candidates: readonly DerivedSnrCandidate[] }, role: DerivedSnrCandidate["role_candidate"], pivotHour: number) =>
  s.candidates.find((c) => c.role_candidate === role && c.origin.pivot_time === T0 + pivotHour * HOUR);
const allInvariants = (r: SnrReport) => {
  for (const tf of Object.keys(r.timeframes) as Timeframe[]) for (const c of r.timeframes[tf].candidates) {
    expect(c.timeframe).toBe(tf);
    expect(c.symbol).toBe(r.symbol);
    expect(c.origin.window_spans_missing_interval).toBe(c.origin.origin_missing_interval_refs.length > 0);
    expect(c.origin.pivot_time).not.toBe(c.available_at);
    expect(c.available_at).toBeLessThanOrEqual(r.as_of);
    for (const x of c.interactions) {
      expect(x.has_missing_interval_uncertainty).toBe(x.missing_interval_refs.length > 0);
      expect(x.bar_open_time).toBeGreaterThanOrEqual(c.origin.confirmation_bar_close_time);
      expect(x.bar_available_at).toBeLessThanOrEqual(r.as_of);
      expect(x.timeframe).toBe(tf);
    }
  }
};

describe("v1d-SNR pure semantics", () => {
  const bar = (o: number, h: number, l: number, c: number, t = 0): ProbeBar => ({ symbol: "XAUUSD", timeframe: "H1", origin: "FIXTURE", open_time: t, close_time: t + HOUR, lifecycle: "CLOSED", closed_at: t + HOUR, available_at: t + HOUR, open: o, high: h, low: l, close: c });
  it("raw geometry: exact equality is AT, not a cross; body_crossed excludes equality", () => {
    const x = interaction(bar(99, 101, 98, 100), 100, "RESISTANCE_CANDIDATE", []);
    expect([x.open_side, x.close_side, x.high_side, x.low_side]).toEqual(["BELOW", "AT", "ABOVE", "BELOW"]);
    expect(x.range_contains_level && x.body_contains_level).toBe(true);
    expect(x.body_crossed_level).toBe(false);
    expect(x.closed_beyond_original_role).toBe(false);
    expect(interaction(bar(99, 101, 98, 100.5), 100, "RESISTANCE_CANDIDATE", []).body_crossed_level).toBe(true);
    expect(interaction(bar(99, 101, 98, 99.5), 100, "SUPPORT_CANDIDATE", ["MI:a"])).toMatchObject({ closed_beyond_original_role: true, has_missing_interval_uncertainty: true });
  });
  it("factual aggregates are two independent facts, both require a strictly later bar", () => {
    const P = 100;
    const xs = [bar(99, 101, 98, 100.5, 0), bar(101, 102, 100.2, 101.5, HOUR)].map((b) => interaction(b, P, "RESISTANCE_CANDIDATE", []));
    const s = factualSummary("RESISTANCE_CANDIDATE", P, xs);
    expect(s).toMatchObject({ close_beyond_count: 2, has_post_close_beyond_range_contains: false, has_post_close_beyond_close_on_original_side: false });
    const ys = [...xs, interaction(bar(101, 101.2, 99.9, 100.1, 2 * HOUR), P, "RESISTANCE_CANDIDATE", [])];
    expect(factualSummary("RESISTANCE_CANDIDATE", P, ys)).toMatchObject({ has_post_close_beyond_range_contains: true, has_post_close_beyond_close_on_original_side: false });
    const zs = [...xs, interaction(bar(101, 101.2, 100, 100, 2 * HOUR), P, "RESISTANCE_CANDIDATE", [])];
    expect(factualSummary("RESISTANCE_CANDIDATE", P, zs).has_post_close_beyond_close_on_original_side).toBe(true);
  });
  it("research register is immutable and has no invented values", () => {
    expect(Object.isFrozen(SNR_RESEARCH_REGISTER)).toBe(true);
    expect(new Set(Object.values(SNR_RESEARCH_REGISTER))).toEqual(new Set(["RESEARCH_REQUIRED"]));
    expect(Object.keys(SNR_RESEARCH_REGISTER)).toEqual(expect.arrayContaining(["touch_definition", "reaction_definition", "rejection_definition", "breakout_classification", "fakeout_classification", "retest_classification", "role_reversal_semantics", "strength_scoring_model", "level_expiry_and_invalidation", "zone_width_and_tolerance"]));
  });
});

describe("v1d-SNR adversarial matrix A–R (application runtime)", () => {
  it("A. swing high → RESISTANCE_CANDIDATE only after causal confirmation", async () => {
    const p = turnHour(0);
    const x = await run(waves([2010, 2004]), { snapAt: [p + 1, p + 2, p + 3] });
    for (const k of [p + 1, p + 2]) expect(cand(x.snaps.get(k)!.timeframes.H1, "RESISTANCE_CANDIDATE", p)).toBeUndefined();
    const c = cand(x.snaps.get(p + 3)!.timeframes.H1, "RESISTANCE_CANDIDATE", p)!;
    expect(c.price).toBe(2010.5);
    expect(c.origin.confirmation_bar_open_time).toBe(T0 + (p + 2) * HOUR);
    expect(c.available_at).toBeGreaterThanOrEqual(c.origin.confirmation_bar_close_time);
    expect(c.origin.confirmed_at).toBeGreaterThanOrEqual(c.origin.confirmation_bar_close_time);
  });
  it("B. swing low → SUPPORT_CANDIDATE only after causal confirmation", async () => {
    const p = turnHour(1);
    const x = await run(waves([2010, 2004, 2008]), { snapAt: [p + 2, p + 3] });
    expect(cand(x.snaps.get(p + 2)!.timeframes.H1, "SUPPORT_CANDIDATE", p)).toBeUndefined();
    expect(cand(x.snaps.get(p + 3)!.timeframes.H1, "SUPPORT_CANDIDATE", p)!.price).toBe(2003.5);
  });
  it("C. geometrically identifiable but unconfirmed pivot yields no candidate (retrospective never enters)", async () => {
    const p = turnHour(0);
    const x = await run(waves([2010, 2004]).slice(0, p + 1)); // only p+1 exists after pivot
    const bars = prepareSeries(fromInternalBars(x.r.closedBars("H1")), "XAUUSD", "H1").bars;
    const s = timeframeSnrState(x.r, "H1", x.r.now());
    expect(cand(s, "RESISTANCE_CANDIDATE", p)).toBeUndefined();
    // With hypothetical right bars the centered detector would label it; causal SNR ignores that.
    const withFuture = await run(waves([2010, 2004]));
    const retro = retrospectiveSwings(prepareSeries(fromInternalBars(withFuture.r.closedBars("H1")), "XAUUSD", "H1").bars, "H1");
    expect(retro.some((r) => r.event_at === T0 + p * HOUR)).toBe(true);
    expect(bars.length).toBeGreaterThan(0);
  });
  it("D. repeated range containment preserved as raw facts; no touch/strength", async () => {
    const r = snrReport((await run(waves([2010, 2004, 2010.2, 2007, 2010.1, 2006]))).r);
    const c = cand(r.timeframes.H1, "RESISTANCE_CANDIDATE", turnHour(0))!;
    expect(c.factual_summary.range_contains_count).toBe(c.interactions.filter((i) => i.range_contains_level).length);
    expect(c.factual_summary.range_contains_count).toBeGreaterThanOrEqual(2);
    expect(json(r)).not.toMatch(NO_SIGNAL);
  });
  it("E. equal highs: both resistance candidates preserved separately, same TF ≠ confluence", async () => {
    const r = snrReport((await run(waves([2010, 2004, 2010, 2006, 2007]))).r);
    const a = cand(r.timeframes.H1, "RESISTANCE_CANDIDATE", turnHour(0))!, b = cand(r.timeframes.H1, "RESISTANCE_CANDIDATE", turnHour(2))!;
    expect(a.price).toBe(b.price);
    expect(a.candidate_id).not.toBe(b.candidate_id);
    expect(r.confluences.some((c) => c.members.every((m) => m.timeframe === "H1"))).toBe(false);
  });
  it("F. equal lows: both support candidates preserved separately", async () => {
    const s = snrReport((await run(waves([2010, 2004, 2009, 2004, 2007]))).r).timeframes.H1;
    const a = cand(s, "SUPPORT_CANDIDATE", turnHour(1))!, b = cand(s, "SUPPORT_CANDIDATE", turnHour(3))!;
    expect(a.price).toBe(b.price);
    expect(a.candidate_id).not.toBe(b.candidate_id);
  });
  it("G. resistance: later candle range contains the level but closes below → closed_beyond false", async () => {
    const c = cand(snrReport((await run(waves([2010, 2004, 2010.2, 2006]))).r).timeframes.H1, "RESISTANCE_CANDIDATE", turnHour(0))!;
    const x = c.interactions.find((i) => i.range_contains_level && i.close_side === "BELOW")!;
    expect(x).toBeDefined();
    expect(x.high_side).toBe("ABOVE");
    expect(x.closed_beyond_original_role).toBe(false);
    expect(x.body_contains_level).toBe(Math.min(x.open, x.close) <= c.price && c.price <= Math.max(x.open, x.close));
    expect(c.factual_summary.close_beyond_count).toBe(0);
  });
  it("H + I. close above resistance recorded; later range containment and close back recorded as separate facts", async () => {
    const r = snrReport((await run(waves([2010, 2004, 2012, 2008, 2009]))).r);
    const c = cand(r.timeframes.H1, "RESISTANCE_CANDIDATE", turnHour(0))!;
    const first = c.interactions.findIndex((i) => i.closed_beyond_original_role);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(c.interactions[first]!.close_side).toBe("ABOVE");
    const later = c.interactions.slice(first + 1);
    expect(c.factual_summary.has_post_close_beyond_range_contains).toBe(later.some((i) => i.range_contains_level));
    expect(c.factual_summary.has_post_close_beyond_range_contains).toBe(true);
    expect(c.factual_summary.has_post_close_beyond_close_on_original_side).toBe(later.some((i) => i.close <= c.price));
    expect(c.role_candidate).toBe("RESISTANCE_CANDIDATE"); // role never changes
    expect(json(r)).not.toMatch(NO_SIGNAL);
  });
  it("J. support mirror: close below, then containment and close at/above support", async () => {
    const c = cand(snrReport((await run(waves([2010, 2004, 2008, 2002, 2006]))).r).timeframes.H1, "SUPPORT_CANDIDATE", turnHour(1))!;
    expect(c.price).toBe(2003.5);
    const first = c.interactions.findIndex((i) => i.closed_beyond_original_role);
    expect(c.interactions[first]!.close).toBeLessThan(c.price);
    expect(c.factual_summary.has_post_close_beyond_range_contains).toBe(true);
    expect(c.factual_summary.has_post_close_beyond_close_on_original_side).toBe(true);
    expect(c.role_candidate).toBe("SUPPORT_CANDIDATE");
  });
  it("K. missing intervals carried as explicit refs in origin and interaction; no fabricated candles", async () => {
    const p = turnHour(0);
    const x = await run(waves([2010, 2004, 2008, 2006, 2009]), { skip: new Set([p + 1, p + 7]) });
    const r = snrReport(x.r);
    allInvariants(r);
    const c = cand(r.timeframes.H1, "RESISTANCE_CANDIDATE", p)!;
    expect(c.origin.origin_missing_interval_refs).toEqual([`MI:XAUUSD:H1:${T0 + (p + 1) * HOUR}`]);
    const hit = c.interactions.find((i) => i.has_missing_interval_uncertainty)!;
    expect(hit.missing_interval_refs).toEqual([`MI:XAUUSD:H1:${T0 + (p + 7) * HOUR}`]);
    expect(c.interactions.some((i) => i.bar_open_time === T0 + (p + 7) * HOUR)).toBe(false);
    expect(x.r.closedBars("H1").some((b) => b.open_time === T0 + (p + 1) * HOUR)).toBe(false);
  });
  it("L. future append cannot rewrite SNR state at earlier T", async () => {
    const specs = waves([2010, 2004, 2012, 2008, 2014, 2007]);
    const x = await run(specs, { snapAt: [12] });
    const T = x.snaps.get(12)!.as_of;
    expect(json(snrReport(x.r, T))).toBe(json(x.snaps.get(12)));
  });
  it("M. replay determinism: same evidence + version + as_of → byte-identical", async () => {
    const specs = waves([2010, 2004, 2012, 2008, 2014]);
    const a = await run(specs), b = await run(specs);
    expect(json(snrReport(a.r))).toBe(json(snrReport(b.r)));
  });
  it("N. MTF isolation: each TF reads only its own candles; runtime unmutated by probe", async () => {
    const x = await run(waves([2010, 2004, 2012, 2008, 2014, 2006]));
    const before = json(x.r.snapshot());
    const full = snrReport(x.r);
    allInvariants(full);
    for (const tf of ["H4", "H1", "M15", "M5"] as Timeframe[]) {
      const only: MarketRuntimeReader = { ...x.r, symbol: x.r.symbol, now: x.r.now, closedBars: (t: Timeframe) => (t === tf ? x.r.closedBars(t) : []) } as MarketRuntimeReader;
      expect(json(timeframeSnrState(only, tf, full.as_of))).toBe(json(full.timeframes[tf]));
    }
    expect(json(x.r.snapshot())).toBe(before);
  });
  it("O. outside bar: both RESISTANCE and SUPPORT candidates survive with outside_bar=true", async () => {
    const w = waves([2010, 2004, 2015, 2008, 2012]);
    const tail: HourSpec[] = [{ c: 2012.5 }, { c: 2013, w: 20 }, { c: 2012.6 }, { c: 2012.2 }, { c: 2012.4 }];
    const s = snrReport((await run([...w, ...tail])).r).timeframes.H1;
    const at = w.length + 2;
    const r = cand(s, "RESISTANCE_CANDIDATE", at)!, sp = cand(s, "SUPPORT_CANDIDATE", at)!;
    expect(r.origin.outside_bar && sp.origin.outside_bar).toBe(true);
    expect(r.origin.swing_id).not.toBe(sp.origin.swing_id);
  });
  it("P. nearby but non-identical prices stay separate; no clustering", async () => {
    const s = snrReport((await run(waves([2010, 2004, 2010.01, 2006, 2007]))).r);
    const a = cand(s.timeframes.H1, "RESISTANCE_CANDIDATE", turnHour(0))!, b = cand(s.timeframes.H1, "RESISTANCE_CANDIDATE", turnHour(2))!;
    expect(b.price - a.price).toBeCloseTo(0.01, 9);
    expect(s.confluences.some((c) => c.members.some((m) => m.id === a.candidate_id) && c.members.some((m) => m.id === b.candidate_id))).toBe(false);
  });
  it("Q. exact-price cross-TF confluence only after all members available; provenance intact", async () => {
    const specs = waves([2010, 2004, 2030, 2000, 2006, 2003, 2005]);
    const x = await run(specs);
    const r = snrReport(x.r);
    allInvariants(r);
    const conf = r.confluences.find((c) => c.members.some((m) => m.timeframe === "H4") && c.members.some((m) => m.timeframe === "H1"))!;
    expect(conf).toBeDefined();
    expect(conf.classification).toBe("CROSS_TF_CONFLUENCE");
    expect(conf.independence).toBe("NOT_ASSUMED");
    expect(conf.available_at).toBe(Math.max(...conf.members.map((m) => m.available_or_effective_at)));
    for (const m of conf.members) {
      const original = r.timeframes[m.timeframe!].candidates.find((c) => c.candidate_id === m.id)!;
      expect(original.price).toBe(conf.price); // members untouched, not merged
    }
    const early = snrReport(x.r, conf.available_at - 1);
    expect(early.confluences.some((c) => c.confluence_id === conf.confluence_id)).toBe(false);
  });
  it("R. USER + DERIVED exact-price confluence respects effective_at; drawing never leaks backward", async () => {
    const x = await run(waves([2010, 2004, 2012, 2008, 2009]));
    const c = cand(timeframeSnrState(x.r, "H1", x.r.now()), "RESISTANCE_CANDIDATE", turnHour(0))!;
    // User draws at hour 14 referring to the market area at hour 3.
    const u = userHorizontalLevel({ id: "U1", symbol: "XAUUSD", price: c.price, role: "RESISTANCE", purpose: "REFERENCE", created_at: T0 + 14 * HOUR, effective_at: T0 + 14 * HOUR });
    expect(() => userHorizontalLevel({ ...u, effective_at: u.created_at - 1 })).toThrow(InvalidUserLevelError);
    const at11 = snrReport(x.r, T0 + 11 * HOUR, [u]);
    expect(at11.user_levels).toEqual([]);
    expect(at11.confluences.some((k) => k.members.some((m) => m.taxonomy === "USER"))).toBe(false);
    const at15 = snrReport(x.r, T0 + 15 * HOUR, [u]);
    const k = at15.confluences.find((k) => k.members.some((m) => m.id === "U1"))!;
    expect(["USER_DERIVED_CONFLUENCE", "MULTI_CONFLUENCE"]).toContain(k.classification);
    expect(k.members.find((m) => m.id === c.candidate_id)!.taxonomy).toBe("DERIVED");
    expect(k.available_at).toBe(Math.max(u.effective_at, c.available_at));
    expect(json(at15)).not.toMatch(NO_SIGNAL);
  });
});

describe("v1d-SNR edge assertions", () => {
  const d = (id: string, symbol: string, price: number, tf: Timeframe, av = 1) => ({ candidate_id: id, symbol, price, timeframe: tf, available_at: av, role_candidate: "RESISTANCE_CANDIDATE" } as DerivedSnrCandidate);
  it("different symbols at identical price never confluence; no float tolerance", () => {
    expect(exactPriceConfluences([d("a", "XAUUSD", 100, "H1"), d("b", "BTCUSD", 100, "H4")], [], 10)).toEqual([]);
    expect(exactPriceConfluences([d("a", "XAUUSD", 0.1 + 0.2, "H1"), d("b", "XAUUSD", 0.3, "H4")], [], 10)).toEqual([]);
    expect(exactPriceConfluences([d("a", "XAUUSD", 0.3, "H1"), d("b", "XAUUSD", 0.3, "H4")], [], 10)).toHaveLength(1);
  });
  it("member ordering deterministic regardless of input order; unavailable member excludes confluence", () => {
    const xs = [d("b", "XAUUSD", 5, "M5"), d("a", "XAUUSD", 5, "H4")];
    expect(json(exactPriceConfluences(xs, [], 10))).toBe(json(exactPriceConfluences([...xs].reverse(), [], 10)));
    expect(exactPriceConfluences([d("a", "XAUUSD", 5, "H4", 20), d("b", "XAUUSD", 5, "M5")], [], 10)).toEqual([]);
  });
  it("no implicit expiry, no role reversal, no evidence disappears because a newer level exists", async () => {
    const x = await run(waves([2010, 2004, 2012, 2008, 2016, 2011, 2020]), { snapAt: [9, 15, 21] });
    const ids = [9, 15, 21].map((k) => new Set(x.snaps.get(k)!.timeframes.H1.candidates.map((c) => c.candidate_id)));
    for (const id of ids[0]!) expect(ids[1]!.has(id) && ids[2]!.has(id)).toBe(true);
    for (const id of ids[1]!) expect(ids[2]!.has(id)).toBe(true);
    const s = x.snaps.get(21)!.timeframes.H1;
    const resBelow = s.candidates.filter((c) => c.role_candidate === "RESISTANCE_CANDIDATE" && c.price < s.current_closed_price!);
    expect(resBelow.length).toBeGreaterThan(0);
    for (const c of resBelow) expect(c.role_candidate).toBe("RESISTANCE_CANDIDATE");
    const sup = s.candidates.filter((c) => c.role_candidate === "SUPPORT_CANDIDATE" && c.price < s.current_closed_price!).map((c) => c.price);
    expect(s.nearest_support_below_price).toBe(sup.length ? Math.max(...sup) : null);
    expect(s.has_support_below).toBe(s.nearest_support_below_price !== null);
    expect(s.is_bracketed_by_candidate_snr).toBe(s.has_support_below && s.has_resistance_above);
    allInvariants(x.snaps.get(21)!);
  });
  it("nearest geometry: closest original-role candidate on each side", async () => {
    const s = snrReport((await run(waves([2010, 2004, 2015, 2008, 2012]))).r).timeframes.H1;
    const p = s.current_closed_price!;
    const sup = s.candidates.filter((c) => c.role_candidate === "SUPPORT_CANDIDATE" && c.price < p).map((c) => c.price);
    const res = s.candidates.filter((c) => c.role_candidate === "RESISTANCE_CANDIDATE" && c.price > p).map((c) => c.price);
    expect(s.nearest_support_below_price).toBe(sup.length ? Math.max(...sup) : null);
    expect(s.nearest_resistance_above_price).toBe(res.length ? Math.min(...res) : null);
  });
});

describe("v1d-SNR safety", () => {
  it("MONITOR_ONLY, execution false, no production import of src/probe, no order_send in snr", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const prod = walk("src").filter((p) => !p.startsWith("src/probe") && !p.startsWith("src/test") && /\.(ts|tsx)$/.test(p));
    for (const p of prod) expect(readFileSync(p, "utf8")).not.toMatch(/probe\//);
    expect(readFileSync("src/probe/technical/snr.ts", "utf8")).not.toMatch(/order_send|order_check|BUY|SELL/);
  });
});
