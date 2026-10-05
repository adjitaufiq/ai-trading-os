// TECHNICAL VALIDATION PROBE v1d — CAUSAL STRUCTURE & LOCATION. DIAGNOSTIC_PROBE / authority NONE. Not Stage 4.
// Integration input: MarketRuntimeReader CLOSED candles from the D2 application chain over a hermetic transport.
// REAL_DATA_VALIDATION = UNAVAILABLE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import {
  classifyLocation, formatStructureLocation, locationState, pairRange, progression, structureLocationReport,
  type ConfirmedLevel, type StructureLocationReport,
} from "@/probe/technical/location";
import { feedHours, HOUR, makeRig, MIN, T0, type HourSpec } from "./helpers/v1cRig";

const json = (x: unknown) => JSON.stringify(x);
const NO_SIGNAL = /"(buy|sell|long|short|entry|stop_loss|take_profit|position_size|risk_pct|signal|recommendation|decision|breakout|bos|choch)"/i;

/** 3-bar legs between turning closes, starting from 2000. Turn i sits at hour 3i+3 (feed starts at hour 1). */
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
  const snaps = new Map<number, StructureLocationReport>();
  feedHours(rig, 1, specs, 2000, o.skip, (k) => { if (o.snapAt?.includes(k)) snaps.set(k, structureLocationReport(rig.r)); });
  return { ...rig, snaps };
}
// turns: P1=2010, T1=2004, P2, T2, end
const UP = [2010, 2004, 2015, 2008];
const H1hi = (c: number) => +(c + 0.5).toFixed(2), H1lo = (c: number) => +(c - 0.5).toFixed(2);

describe("v1d pure semantics", () => {
  const L = (type: "SWING_HIGH" | "SWING_LOW", p: number, av: number): ConfirmedLevel => ({ type, timeframe: "H1", pivot_time: 0, pivot_price: p, confirmation_open_time: 0, confirmed_at: av, available_at: av, outside_bar: false, window_spans_missing_interval: false, algorithm_version: "x" });
  it("equality is explicit, never HH/LH/HL/LL", () => {
    expect(progression("HIGH", L("SWING_HIGH", 10, 1), L("SWING_HIGH", 10, 2))).toBe("EQUAL_HIGH");
    expect(progression("LOW", L("SWING_LOW", 5, 1), L("SWING_LOW", 5, 2))).toBe("EQUAL_LOW");
  });
  it("range pairing: available_at = max(high, low); unusable before it or when H <= L; exact boundaries", () => {
    const h = L("SWING_HIGH", 10, 100), l = L("SWING_LOW", 5, 200);
    expect(pairRange(h, l, 150)).toMatchObject({ status: "UNAVAILABLE", reason: "NOT_YET_AVAILABLE", available_at: 200 });
    expect(pairRange(h, l, 200)).toMatchObject({ status: "USABLE", available_at: 200 });
    expect(pairRange(L("SWING_HIGH", 5, 1), L("SWING_LOW", 5, 1), 9)).toMatchObject({ status: "UNAVAILABLE", reason: "HIGH_NOT_ABOVE_LOW" });
    const r = pairRange(h, l, 300);
    expect(classifyLocation(10, h, l, r)).toBe("AT_UPPER_BOUNDARY");
    expect(classifyLocation(5, h, l, r)).toBe("AT_LOWER_BOUNDARY");
    expect(classifyLocation(10.000001, h, l, r)).toBe("ABOVE_CONFIRMED_SWING_HIGH");
  });
});

describe("v1d adversarial MarketRuntime scenarios", () => {
  it("A. confirmed HH (+HL): HH only once confirmation is available", async () => {
    const p2 = turnHour(2);
    const x = await run(waves([...UP, 2012]), { snapAt: [p2 + 2, p2 + 3] });
    const pre = x.snaps.get(p2 + 2)!.location.H1, post = x.snaps.get(p2 + 3)!.location.H1;
    expect(pre.latest_high?.pivot_time).toBe(T0 + turnHour(0) * HOUR);
    expect(pre.high_progression).not.toBe("HH");
    expect(post.latest_high?.pivot_time).toBe(T0 + p2 * HOUR);
    expect(post.high_progression).toBe("HH");
    const end = structureLocationReport(x.r).location.H1;
    expect(end.high_progression).toBe("HH");
    expect(end.low_progression).toBe("HL");
  });
  it("B. confirmed LH (+LL)", async () => {
    const x = await run(waves([2010, 2004, 2008, 2000, 2004]));
    const s = structureLocationReport(x.r).location.H1;
    expect(s.high_progression).toBe("LH");
    expect(s.low_progression).toBe("LL");
  });
  it("C. confirmed HL with LH (mixed progression kept as facts)", async () => {
    const s = structureLocationReport((await run(waves([2010, 2004, 2008, 2006, 2007]))).r).location.H1;
    expect(s.low_progression).toBe("HL");
    expect(s.high_progression).toBe("LH");
  });
  it("D. confirmed LL with HH", async () => {
    const s = structureLocationReport((await run(waves([2010, 2004, 2012, 2002, 2006]))).r).location.H1;
    expect(s.low_progression).toBe("LL");
    expect(s.high_progression).toBe("HH");
  });
  it("E. equal highs → EQUAL_HIGH, not HH/LH", async () => {
    const s = structureLocationReport((await run(waves([2010, 2004, 2010, 2006, 2007]))).r).location.H1;
    expect(s.latest_high!.pivot_price).toBe(s.previous_high!.pivot_price);
    expect(s.high_progression).toBe("EQUAL_HIGH");
  });
  it("F. obvious pivot without its right-side confirmation is not a usable level", async () => {
    const p = turnHour(0);
    const x = await run(waves([2010, 2004]), { snapAt: [p + 1, p + 2, p + 3] });
    for (const k of [p + 1, p + 2]) expect(x.snaps.get(k)!.location.H1.latest_high).toBeNull();
    const ok = x.snaps.get(p + 3)!.location.H1.latest_high!;
    expect(ok.pivot_time).toBe(T0 + p * HOUR);
    expect(ok.available_at).toBeGreaterThan(ok.pivot_time + HOUR); // pivot_time is never the availability
  });
  it("G. confirmation after a real gap: available_at from the actual confirming candle, not pivot + N×TF", async () => {
    const p = turnHour(0);
    const x = await run(waves([2010, 2004, 2008]), { skip: new Set([p + 1]) });
    const lvl = locationState(x.r, "H1", x.r.now()).latest_high!;
    const conf = x.r.closedBars("H1").find((b) => b.open_time === T0 + (p + 3) * HOUR)!;
    expect(lvl.pivot_time).toBe(T0 + p * HOUR);
    expect(lvl.confirmation_open_time).toBe(conf.open_time);
    expect(lvl.available_at).toBe(Math.max(conf.closed_at!, conf.available_at));
    expect(lvl.available_at).not.toBe(lvl.pivot_time + 3 * HOUR); // synthetic pivot + (R+1)×TF
    expect(lvl.window_spans_missing_interval).toBe(true);
  });
  it("H. closed price above confirmed high → ABOVE_CONFIRMED_SWING_HIGH (no breakout field)", async () => {
    const s = structureLocationReport((await run(waves([...UP, 2025]))).r);
    expect(s.location.H1.latest_high!.pivot_price).toBe(H1hi(2015));
    expect(s.location.H1.location).toBe("ABOVE_CONFIRMED_SWING_HIGH");
    expect(json(s)).not.toMatch(NO_SIGNAL);
  });
  it("I. closed price below confirmed low → BELOW_CONFIRMED_SWING_LOW (no short field)", async () => {
    const s = structureLocationReport((await run(waves([...UP, 1995]))).r);
    expect(s.location.H1.latest_low!.pivot_price).toBe(H1lo(2008));
    expect(s.location.H1.location).toBe("BELOW_CONFIRMED_SWING_LOW");
    expect(json(s)).not.toMatch(NO_SIGNAL);
  });
  it("J. inside range → INSIDE_CONFIRMED_SWING_RANGE with exact normalized position", async () => {
    const s = structureLocationReport((await run(waves([...UP, 2012]))).r).location.H1;
    expect(s.location).toBe("INSIDE_CONFIRMED_SWING_RANGE");
    const H = H1hi(2015), Lo = H1lo(2008);
    expect(s.range.status).toBe("USABLE");
    expect(s.range.available_at).toBe(Math.max(s.latest_high!.available_at, s.latest_low!.available_at));
    expect(s.range_position).toBe((s.current_closed_price! - Lo) / (H - Lo));
  });
  it("K. outside bar dual swing: both levels survive; ambiguity reported, not guessed", async () => {
    const w = waves([...UP, 2012]);
    const tail: HourSpec[] = [{ c: 2012.5 }, { c: 2013, w: 20 }, { c: 2012.6 }, { c: 2012.2 }, { c: 2012.4 }];
    const s = structureLocationReport((await run([...w, ...tail])).r).location.H1;
    const at = T0 + (w.length + 2) * HOUR;
    expect(s.latest_high!.pivot_time).toBe(at);
    expect(s.latest_low!.pivot_time).toBe(at);
    expect(s.latest_high!.outside_bar && s.latest_low!.outside_bar).toBe(true);
    expect(s.range.outside_bar_dual_swing).toBe(true);
    expect(s.progression_ambiguity).toBe("OUTSIDE_BAR_DUAL_SWING");
  });
  it("L. forming candle trades above confirmed high → CLOSED_LOCATION unchanged (no live location stream)", async () => {
    const specs = waves([...UP, 2012]);
    const x = await run(specs);
    const k = specs.length + 1;
    x.live({ ms: T0 + k * HOUR + 1 * MIN, bid: 2012 }); // closes last hour
    const before = locationState(x.r, "H1", x.r.now());
    x.live({ ms: T0 + k * HOUR + 20 * MIN, bid: 2030 });
    expect(x.r.formingBar("H1")!.high).toBeGreaterThan(before.latest_high!.pivot_price);
    const after = locationState(x.r, "H1", x.r.now());
    expect(after.location_policy).toBe("CLOSED_LOCATION_ONLY");
    expect(json({ ...after, as_of: 0 })).toBe(json({ ...before, as_of: 0 }));
    expect(after.location).toBe("INSIDE_CONFIRMED_SWING_RANGE");
  });
  it("M. future append: structure/location at T byte-identical after appending candles", async () => {
    const x = await run(waves([...UP, 2025, 2010]), { snapAt: [9, 13, 16, 20] });
    for (const [, snap] of x.snaps) expect(json(structureLocationReport(x.r, snap.as_of))).toBe(json(snap));
  });
  it("N. replay: identical fixture → identical structure/location output", async () => {
    const a = await run(waves([...UP, 2012]), { symbol: "BTCUSD" }), b = await run(waves([...UP, 2012]), { symbol: "BTCUSD" });
    expect(json(structureLocationReport(a.r))).toBe(json(structureLocationReport(b.r)));
  });
  it("O. MTF isolation: altered M5 swings leave H1/H4 structure and location unchanged; timeframe ownership kept", async () => {
    const w = waves([...UP, 2012, 2006, 2016, 2009, 2013]);
    const a = await run(w), b = await run(w.map((h, i) => ({ ...h, extra: i % 2 === 0 })));
    const ra = structureLocationReport(a.r), rb = structureLocationReport(b.r);
    expect(json(ra.location.M5)).not.toBe(json(rb.location.M5));
    for (const tf of ["H1", "H4"] as const) {
      expect(json(ra.location[tf])).toBe(json(rb.location[tf]));
      expect(json(ra.technical.timeframes[tf])).toBe(json(rb.technical.timeframes[tf]));
    }
    for (const tf of ["M5", "M15", "H1", "H4"] as const) for (const l of [ra.location[tf].latest_high, ra.location[tf].latest_low]) if (l) expect(l.timeframe).toBe(tf);
    console.log(`[v1d O]\n${formatStructureLocation(ra)}`);
  });
});

describe("v1d authority / safety", () => {
  it("MONITOR_ONLY, execution disabled, no signal/BOS/CHoCH/execution surface in the probe", () => {
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    const src = readFileSync("src/probe/technical/location.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/order_send|order_check|StrategyDecision|retrospectiveSwings|\bBOS\b|CHoCH|BUY|SELL/);
  });
});
