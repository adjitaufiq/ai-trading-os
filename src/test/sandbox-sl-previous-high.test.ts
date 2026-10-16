// SANDBOX ONLY — hypothesis test for an M3 SELL SL fallback to a confirmed M15 previousHigh.
// The fallback lives ONLY in this file (sandboxStopLoss). Production slCalculator.ts is untouched and is
// only observed (wrapped) here. No orders, no broker, no config/runtime change. Not evidence of production readiness.
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Bar, Timeframe } from "@/core/contracts";
import type { MarketStructure, SwingPoint } from "@/engine/core/swing/types";
import { PLAN_PARAMS, type SlCalc } from "@/engine/plan/types";
import { TARGET_CLAMP_PARAMS } from "@/core/technical/tradingState";
import type { SlInput } from "@/engine/plan/slCalculator";

const recorded: { input: SlInput; result: SlCalc }[] = [];
vi.mock("@/engine/plan/slCalculator", async (orig) => {
  const real = await orig<typeof import("@/engine/plan/slCalculator")>();
  return { ...real, calculateStopLoss: (i: SlInput) => { const r = real.calculateStopLoss(i); recorded.push({ input: structuredClone(i), result: r }); return r; } };
});

const { calculateStopLoss } = await import("@/engine/plan/slCalculator");
const { calculateTakeProfit } = await import("@/engine/plan/tpCalculator");

/** Harness copy: production rule first; then (SELL only) confirmed M15 previousHigh, same buffer, same MAX_SL_ATR. */
function sandboxStopLoss(i: SlInput): SlCalc & { fallback?: boolean } {
  const base = calculateStopLoss(i);
  if (base.ok || base.reason !== "NO_SL_ANCHOR" || i.direction !== "SELL") return base;
  const p = i.m15Structure.previousHigh;
  if (!p || p.timeframe !== "M15" || p.confirmedAt > i.now || !(Number.isFinite(p.price) && p.price > i.entry)) return base;
  const sl = p.price + i.atr * PLAN_PARAMS.SL_ATR_BUFFER, distance = Math.abs(i.entry - sl);
  if (distance > i.atr * PLAN_PARAMS.MAX_SL_ATR) return { ok: false, reason: "SL_TOO_WIDE", anchor: p.price, distance };
  return { ok: true, sl, anchor: p.price, source: "M15_CONFIRMED_SWING", distance, fallback: true };
}

/** Same TP + RR rule as tradePlanEngine (uses production calculateTakeProfit and PLAN_PARAMS.MIN_RR). */
function planOutcome(i: SlInput, sl: SlCalc): "PLANNED" | "NO_SL_ANCHOR" | "SL_TOO_WIDE" | "NO_TP_TARGET" | "BAD_RR" {
  if (!sl.ok) return sl.reason;
  const tp = calculateTakeProfit({ direction: i.direction, entry: i.entry, m15Structure: i.m15Structure, atr: i.atr, now: i.now });
  if (!tp.ok) return "NO_TP_TARGET";
  return Math.abs(tp.tp - i.entry) / sl.distance >= PLAN_PARAMS.MIN_RR ? "PLANNED" : "BAD_RR";
}

const sw = (type: "HIGH" | "LOW", price: number, confirmedAt: number): SwingPoint => ({ id: `${type}${price}`, symbol: "XAUUSD", timeframe: "M15", type, price, timestamp: confirmedAt - 2700, confirmedAt, strength: "NORMAL", leftBars: 2, rightBars: 2, rejectionWickRatio: 0.3 });
const st = (o: Partial<MarketStructure>): MarketStructure => ({ symbol: "XAUUSD", timeframe: "M15", trend: "RANGE", lastConfirmedHigh: null, lastConfirmedLow: null, previousHigh: null, previousLow: null, structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: 1000, ...o });
const NOW = 10_000, ATR = 4, ENTRY = 2000;
const sell = (s: MarketStructure, now = NOW): SlInput => ({ direction: "SELL", entry: ENTRY, keyLevel: NaN, m15Structure: s, atr: ATR, now });

describe("active thresholds read from source (no assumption)", () => {
  it("execution plan (M3) and Radar have separate RR minimums", () => {
    expect(PLAN_PARAMS.MIN_RR).toBe(1.2);
    expect(TARGET_CLAMP_PARAMS.min_rr_for_actionable).toBe(1.0);
    expect(PLAN_PARAMS.MAX_SL_ATR).toBe(2.5);
    expect(PLAN_PARAMS.SL_ATR_BUFFER).toBe(0.25);
  });
});

describe("sandbox previousHigh fallback (synthetic)", () => {
  const lastBelow = sw("HIGH", 1998, 9000);
  it("baseline production rejects NO_SL_ANCHOR when lastConfirmedHigh is below entry", () => {
    expect(calculateStopLoss(sell(st({ lastConfirmedHigh: lastBelow, previousHigh: sw("HIGH", 2005, 8000) })))).toMatchObject({ ok: false, reason: "NO_SL_ANCHOR" });
  });
  it("unconfirmed previousHigh (confirmedAt > now) ⇒ rejected", () => {
    expect(sandboxStopLoss(sell(st({ lastConfirmedHigh: lastBelow, previousHigh: sw("HIGH", 2005, NOW + 1) })))).toMatchObject({ ok: false, reason: "NO_SL_ANCHOR" });
  });
  it("confirmed previousHigh above entry within limits ⇒ accepted in sandbox only", () => {
    const r = sandboxStopLoss(sell(st({ lastConfirmedHigh: lastBelow, previousHigh: sw("HIGH", 2005, 8000) })));
    expect(r).toMatchObject({ ok: true, anchor: 2005, sl: 2006, distance: 6, fallback: true });
  });
  it("SL beyond MAX_SL_ATR ⇒ SL_TOO_WIDE", () => {
    expect(sandboxStopLoss(sell(st({ lastConfirmedHigh: lastBelow, previousHigh: sw("HIGH", 2010, 8000) })))).toMatchObject({ ok: false, reason: "SL_TOO_WIDE" });
  });
  it("RR below active MIN_RR ⇒ still BAD_RR", () => {
    const s = st({ lastConfirmedHigh: lastBelow, previousHigh: sw("HIGH", 2005, 8000), lastConfirmedLow: sw("LOW", 1995, 8500) });
    const i = sell(s);
    expect(planOutcome(i, sandboxStopLoss(i))).toBe("BAD_RR"); // reward 4.6 / risk 6 < 1.2
  });
  it("RR at/above MIN_RR ⇒ PLANNED in sandbox", () => {
    const i = sell(st({ lastConfirmedHigh: lastBelow, previousHigh: sw("HIGH", 2005, 8000), lastConfirmedLow: sw("LOW", 1990, 8500) }));
    expect(planOutcome(i, sandboxStopLoss(i))).toBe("PLANNED");
  });
  it("anti-lookahead: same structure, earlier asOf hides the swing", () => {
    const s = st({ lastConfirmedHigh: lastBelow, previousHigh: sw("HIGH", 2005, 8000) });
    expect(sandboxStopLoss(sell(s, 7999)).ok).toBe(false);
    expect(sandboxStopLoss(sell(s, 8000)).ok).toBe(true);
  });
  it("variant never changes a case production already accepts or a BUY", () => {
    const ok = sell(st({ lastConfirmedHigh: sw("HIGH", 2004, 8000), previousHigh: sw("HIGH", 2006, 7000) }));
    expect(sandboxStopLoss(ok)).toEqual(calculateStopLoss(ok));
    const buy = { ...ok, direction: "BUY" as const };
    expect(sandboxStopLoss(buy)).toEqual(calculateStopLoss(buy));
  });
});

// ---- 48h replay over broker CLOSED bars (read-only data file fetched separately) ----
const DATA = process.env["SL_REPLAY_DATA"];
describe.skipIf(!DATA || !existsSync(DATA))("48h replay baseline vs sandbox (paper path, no orders)", () => {
  it("records every production SL call and evaluates the variant on identical inputs", async () => {
    const { runAlignedReplay } = await import("@/core/paper/alignedReplay");
    const raw = JSON.parse(readFileSync(DATA!, "utf8"));
    const TFMS: Record<string, number> = { M5: 3e5, M15: 9e5, H1: 36e5, H4: 144e5 };
    const report: Record<string, unknown> = { fetched_at_ms: raw.fetched_at_ms, sandbox: true, orders_sent: 0 };
    for (const symbol of ["XAUUSD", "BTCUSD"]) {
      const bars: Partial<Record<Timeframe, Bar[]>> = {}, quality: Record<string, unknown> = {};
      const spreads: number[] = [];
      const point = raw.spec[symbol].point;
      for (const tf of ["M5", "M15", "H1", "H4"] as Timeframe[]) {
        const seen = new Map<number, Bar>();
        for (const x of raw.bars[symbol][tf]) {
          const o = x.raw_time_s * 1000, c = o + TFMS[tf]!;
          if (c > raw.fetched_at_ms) continue; // forming bar excluded
          if (tf === "M5") spreads.push(x.spread * point);
          seen.set(o, { symbol, timeframe: tf, source: "MT5", open_time: o, close_time: c, status: "CLOSED", closed_at: c, effective_at: c, available_at: c, open: x.open, high: x.high, low: x.low, close: x.close, tick_count: x.tick_volume, revision: 0 } as unknown as Bar);
        }
        const arr = [...seen.values()].sort((a, b) => a.open_time - b.open_time);
        bars[tf] = arr;
        const gaps = arr.slice(1).map((b, k) => (b.open_time - arr[k]!.open_time) / TFMS[tf]! - 1).filter((g) => g > 0);
        quality[tf] = { count: arr.length, first: arr[0]?.open_time, last: arr.at(-1)?.open_time, gap_events: gaps.length, missing_slots: gaps.reduce((a, g) => a + g, 0), largest_gap_slots: Math.max(0, ...gaps) };
      }
      const m5 = bars.M5!, windowStart = raw.fetched_at_ms - 48 * 36e5;
      const maxBars = m5.filter((b) => b.open_time >= windowStart).length;
      const med = [...spreads].sort((a, b) => a - b)[Math.floor(spreads.length / 2)] ?? 0;
      const spec = { symbol, origin: "BROKER_REPORTED" as const, digits: raw.spec[symbol].digits, point, tick_size: point, contract_size: raw.spec[symbol].trade_contract_size, broker_utc_offset_ms: 0 };
      recorded.length = 0;
      const res = runAlignedReplay(symbol, spec, bars, { maxBars, costModel: { spread: med, source: "ASSUMED_FIXED", note: "median M5 bar spread from broker bars", slippage: 0, latencyMs: 0 } });
      if (res.status !== "DONE") { report[symbol] = { status: "UNKNOWN", missing: res.missing, quality }; continue; }
      const tally = (f: (i: SlInput, r: SlCalc) => string) => recorded.reduce<Record<string, number>>((m, x) => { const k = f(x.input, x.result); m[k] = (m[k] ?? 0) + 1; return m; }, {});
      const extra = recorded.filter((x) => !x.result.ok && x.result.reason === "NO_SL_ANCHOR").map((x) => {
        const v = sandboxStopLoss(x.input);
        return { asOf: x.input.now, direction: x.input.direction, entry: x.input.entry, atr: x.input.atr, lastHigh: x.input.m15Structure.lastConfirmedHigh?.price ?? null, prevHigh: x.input.m15Structure.previousHigh?.price ?? null, prevHighConfirmedAt: x.input.m15Structure.previousHigh?.confirmedAt ?? null, variantSl: v.ok ? v.sl : null, variantOutcome: planOutcome(x.input, v) };
      });
      report[symbol] = {
        status: "DONE", replay_window: { start: m5.at(-maxBars)?.open_time, end: m5.at(-1)?.close_time, m5_bars: maxBars }, quality, spread_assumed: med,
        funnel: { ...res.summary, plan_stage_calls: recorded.length },
        baseline: tally((i, r) => planOutcome(i, r)), variant: tally((i) => planOutcome(i, sandboxStopLoss(i))),
        no_sl_anchor_cases: extra,
      };
      for (const x of recorded) expect(x.input.m15Structure.lastConfirmedHigh?.confirmedAt ?? 0).toBeLessThanOrEqual(x.input.now); // no lookahead
    }
    writeFileSync("/tmp/replay/report.json", JSON.stringify(report, null, 1));
  }, 300_000);
});
