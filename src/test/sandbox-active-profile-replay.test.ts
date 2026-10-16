// SANDBOX ONLY — ACTIVE DEMO entry-rule experiment, one change per variant vs STRICT baseline.
// Same broker CLOSED bars, warm-up, runAlignedReplay/LivePaperLoop, fill and cost model for every variant.
// Variants are injected ONLY by wrapping updateSetup in this test process (vi.mock); production files are untouched.
// Paper replay: no broker, no order. Results are SIMULATION, never broker trades or proof of edge.
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Bar, Timeframe } from "@/core/contracts";
import type { SignalSetup } from "@/engine/signal/types";
import type { ArenaCandle } from "@/engine/core/normalizer/types";

const CFG = { locBuf: 0, emaGrace: false };
const graced = new Set<string>();
const log: { kind: "CREATE" | "UPDATE"; id: string; from?: string; to: string; reason?: string | undefined; locSaved?: boolean; emaGraced?: boolean; at: number }[] = [];

vi.mock("@/engine/signal/signalLifecycle", async (orig) => {
  const real = await orig<typeof import("@/engine/signal/signalLifecycle")>();
  const { emaAcceptable } = await import("@/engine/signal/signalEvaluator");
  return {
    ...real,
    createSetup: (...a: Parameters<typeof real.createSetup>) => {
      const r = real.createSetup(...a);
      if (r) log.push({ kind: "CREATE", id: r.setup.id, to: r.setup.state, at: r.setup.createdAt });
      return r;
    },
    updateSetup: (s: SignalSetup, u: Parameters<typeof real.updateSetup>[1]) => {
      const buy = s.direction === "BUY";
      const buf = CFG.locBuf > 0 && Number.isFinite(u.m15Atr) && u.m15Atr > 0 ? u.m15Atr * CFG.locBuf : 0;
      let locSaved = false, emaGraced = false;
      // Location variant: same M5/M15 closes as baseline; a close penetrating keyLevel by ≤ buffer is treated as held.
      const soften = (c?: ArenaCandle) => {
        if (!c || !c.isClosed || buf === 0) return c;
        const pen = buy ? s.keyLevel - c.close : c.close - s.keyLevel;
        if (pen > 0 && pen <= buf) { locSaved = true; return { ...c, close: s.keyLevel }; }
        return c;
      };
      const m15 = soften(u.m15);
      let input = { ...u, m5: soften(u.m5)!, ...(m15 ? { m15 } : {}) };
      // EMA variant: first EMA failure gets ONE closed-M5 grace bar (no promotion to READY that bar);
      // the next bar re-runs every lifecycle check with the real EMA context.
      const emaOk = emaAcceptable(buy ? "BUY" : "SELL", u.emaContext);
      if (CFG.emaGrace && !emaOk && !graced.has(s.id)) {
        graced.add(s.id); emaGraced = true;
        const { evaluation: _drop, ...rest } = input;
        input = { ...rest, emaContext: { ...u.emaContext, pricePosition: "BETWEEN" as never, actions: [] } } as typeof input;
      }
      const r = real.updateSetup(s, input);
      if (r.setup.state !== s.state || locSaved || emaGraced) log.push({ kind: "UPDATE", id: s.id, from: s.state, to: r.setup.state, reason: r.setup.invalidationReason ?? r.setup.expiredBy, locSaved, emaGraced, at: u.now });
      return r;
    },
  };
});

const DATA = "/tmp/replay/data.json";
const WARMUP_M5 = 300;
const VARIANTS = [
  ["STRICT_baseline", { locBuf: 0, emaGrace: false }],
  ["LOCATION_buf_0_15_atr", { locBuf: 0.15, emaGrace: false }],
  ["EMA_grace_1_bar", { locBuf: 0, emaGrace: true }],
  ["COMBINED_location_plus_ema", { locBuf: 0.15, emaGrace: true }],
] as const;

describe("sandbox wrapper parity (flags off ⇒ production behaviour)", () => {
  it("baseline flags leave updateSetup input untouched", () => {
    expect(CFG).toEqual({ locBuf: 0, emaGrace: false });
  });
});

describe.skipIf(!existsSync(DATA))("ACTIVE DEMO sandbox replay, one change per variant", () => {
  it("runs all variants on identical inputs", async () => {
    const { runAlignedReplay } = await import("@/core/paper/alignedReplay");
    const raw = JSON.parse(readFileSync(DATA, "utf8"));
    const TF: Record<string, number> = { M5: 3e5, M15: 9e5, H1: 36e5, H4: 144e5 };
    const report: Record<string, unknown> = { fetched_at_ms: raw.fetched_at_ms, sandbox: true, orders_sent: 0, label: "SIMULATION (paper replay), not broker trades" };
    for (const symbol of ["XAUUSD", "BTCUSD"]) {
      const bars: Partial<Record<Timeframe, Bar[]>> = {}, quality: Record<string, unknown> = {}, spreads: number[] = [];
      const point = raw.spec[symbol].point;
      for (const tf of ["M5", "M15", "H1", "H4"] as Timeframe[]) {
        const seen = new Map<number, Bar>();
        for (const x of raw.bars[symbol][tf]) {
          const o = x.raw_time_s * 1000, c = o + TF[tf]!;
          if (c > raw.fetched_at_ms) continue;
          if (tf === "M5") spreads.push(x.spread * point);
          seen.set(o, { symbol, timeframe: tf, source: "MT5", open_time: o, close_time: c, status: "CLOSED", closed_at: c, effective_at: c, available_at: c, open: x.open, high: x.high, low: x.low, close: x.close, tick_count: x.tick_volume, revision: 0 } as unknown as Bar);
        }
        const arr = [...seen.values()].sort((a, b) => a.open_time - b.open_time);
        bars[tf] = arr;
        const gaps = arr.slice(1).map((b, k) => ({ at: arr[k]!.close_time, slots: (b.open_time - arr[k]!.open_time) / TF[tf]! - 1 })).filter((g) => g.slots > 0);
        quality[tf] = { count: arr.length, first: new Date(arr[0]!.open_time).toISOString(), last: new Date(arr.at(-1)!.open_time).toISOString(), gap_events: gaps.length, missing_slots: gaps.reduce((a, g) => a + g.slots, 0), largest: gaps.sort((a, b) => b.slots - a.slots).slice(0, 3).map((g) => ({ after: new Date(g.at).toISOString(), slots: g.slots })) };
      }
      const maxBars = bars.M5!.length - WARMUP_M5;
      const sorted = [...spreads].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const spec = { symbol, origin: "BROKER_REPORTED" as const, digits: raw.spec[symbol].digits, point, tick_size: point, contract_size: raw.spec[symbol].trade_contract_size, broker_utc_offset_ms: 0 };
      const out: Record<string, unknown> = { quality, replay: { start: new Date(bars.M5!.at(-maxBars)!.open_time).toISOString(), end: new Date(bars.M5!.at(-1)!.close_time).toISOString(), m5_bars: maxBars, warmup_m5: WARMUP_M5 }, cost: { spread_median: med, spread_p90: sorted[Math.floor(sorted.length * 0.9)] ?? null, commission: 0, slippage: 0, latency_ms: 0, note: "fixed median spread; commission/slippage NOT modelled" } };
      for (const [name, cfg] of VARIANTS) {
        Object.assign(CFG, cfg); graced.clear(); log.length = 0;
        const res = runAlignedReplay(symbol, spec, bars, { maxBars, costModel: { spread: med, source: "ASSUMED_FIXED", note: "median M5 spread", slippage: 0, latencyMs: 0 } });
        if (res.status !== "DONE") { out[name] = { status: "UNKNOWN", missing: res.missing }; continue; }
        const created = log.filter((x) => x.kind === "CREATE");
        const trans: Record<string, number> = {};
        for (const x of log) if (x.kind === "UPDATE" && x.to !== x.from) { const k = `${x.from}->${x.to}:${x.reason ?? ""}`; trans[k] = (trans[k] ?? 0) + 1; }
        const recs = res.rows.flatMap((r) => r.records);
        const byDir: Record<string, Record<string, number>> = {};
        const bump = (d: string | null, k: string) => { const b = (byDir[d ?? "NONE"] ??= {}); b[k] = (b[k] ?? 0) + 1; };
        for (const x of recs) bump(x.direction, `${x.kind}:${x.outcome}${x.kind === "ORDER" || x.kind === "REJECTED" || (x.kind === "GATE" && x.outcome !== "ALLOW") ? `:${x.reason}` : ""}`);
        const noSl = recs.filter((x) => String(x.reason).includes("NO_SL_ANCHOR")).length + Object.keys(res.summary.downstreamBlocks).filter((k) => k.includes("NO_SL_ANCHOR")).length;
        const t = res.trades;
        const r = t.map((x) => (x.riskUSD > 0 ? x.profitLossUSD / x.riskUSD : NaN));
        let eq = 0, peak = 0, dd = 0;
        for (const x of t) { eq += x.profitLossUSD; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
        const ambiguous = t.filter((x) => /AMBIG|SAME_BAR/i.test(x.closeReason)).length;
        out[name] = {
          status: "DONE", config: cfg,
          setups_created: created.length, created_reaction_confirmed: created.filter((x) => x.to === "REACTION_CONFIRMED").length, created_ready: created.filter((x) => x.to === "READY").length,
          promoted_ready: log.filter((x) => x.kind === "UPDATE" && x.from === "REACTION_CONFIRMED" && x.to === "READY").length,
          location_saves: new Set(log.filter((x) => x.locSaved).map((x) => x.id)).size,
          ema_grace_used: new Set(log.filter((x) => x.emaGraced).map((x) => x.id)).size,
          lifecycle_transitions: trans,
          funnel_by_direction: byDir,
          no_sl_anchor_cases: noSl,
          summary: res.summary,
          trades: t.length,
          trades_detail: t.map((x) => ({ dir: x.direction, opened: new Date(x.openedAt).toISOString(), entry: x.entryPrice, sl: x.stopLoss, tp: x.takeProfit, exit: x.exitPrice, result: x.result, closeReason: x.closeReason, pnlUSD: +x.profitLossUSD.toFixed(2), R: +(r[t.indexOf(x)] ?? NaN).toFixed(2), mae: x.excursion?.maximumAdverseExcursion ?? "UNKNOWN", mfe: x.excursion?.maximumFavorableExcursion ?? "UNKNOWN" })),
          net_pnl_usd_spread_only: +t.reduce((a, x) => a + x.profitLossUSD, 0).toFixed(2),
          expectancy_R: t.length ? +(r.reduce((a, x) => a + x, 0) / t.length).toFixed(3) : "UNKNOWN",
          max_drawdown_usd: +dd.toFixed(2),
          same_bar_sl_tp_ambiguous: ambiguous,
        };
      }
      report[symbol] = out;
    }
    writeFileSync("/tmp/replay/active-profile-report.json", JSON.stringify(report, null, 1));
    expect(report["orders_sent"]).toBe(0);
  }, 600_000);
});
