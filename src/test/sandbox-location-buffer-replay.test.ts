// SANDBOX ONLY — paired replay: baseline LOCATION_BROKEN (0 ATR) vs sandbox buffer (0.15 × M15 ATR).
// Same broker CLOSED bars, same runAlignedReplay/LivePaperLoop, same warm-up/cost; the ONLY difference is the
// location predicate injected by mocking updateSetup in this test process. Production files are untouched.
// Paper replay only: no broker, no order. Results are SIMULATION, never broker trades.
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Bar, Timeframe } from "@/core/contracts";
import type { SignalSetup } from "@/engine/signal/types";
import type { ArenaCandle } from "@/engine/core/normalizer/types";

const BUF = { v: 0 };
const log: { kind: "CREATE" | "UPDATE"; id: string; from?: string; to: string; reason?: string | undefined; saved?: boolean | undefined; at: number; key?: number; close?: number; atr?: number }[] = [];

vi.mock("@/engine/signal/signalLifecycle", async (orig) => {
  const real = await orig<typeof import("@/engine/signal/signalLifecycle")>();
  return {
    ...real,
    createSetup: (...a: Parameters<typeof real.createSetup>) => {
      const r = real.createSetup(...a);
      if (r) log.push({ kind: "CREATE", id: r.setup.id, to: r.setup.state, at: r.setup.createdAt, key: r.setup.keyLevel });
      return r;
    },
    updateSetup: (s: SignalSetup, u: Parameters<typeof real.updateSetup>[1]) => {
      const buf = Number.isFinite(u.m15Atr) && u.m15Atr > 0 ? u.m15Atr * BUF.v : 0;
      const buy = s.direction === "BUY";
      let saved = false;
      const soften = (c?: ArenaCandle) => {
        if (!c || !c.isClosed) return c;
        const pen = buy ? s.keyLevel - c.close : c.close - s.keyLevel;
        if (pen > 0 && pen <= buf) { saved = true; return { ...c, close: s.keyLevel }; }
        return c;
      };
      const m15 = soften(u.m15);
      const r = real.updateSetup(s, { ...u, m5: soften(u.m5)!, ...(m15 ? { m15 } : {}) });
      if (r.setup.state !== s.state || saved) log.push({ kind: "UPDATE", id: s.id, from: s.state, to: r.setup.state, reason: r.setup.invalidationReason ?? r.setup.expiredBy, saved: saved || undefined, at: u.now, key: s.keyLevel, close: u.m5.close, atr: u.m15Atr });
      return r;
    },
  };
});

const DATA = "/tmp/replay/data.json";
const WARMUP_M5 = 300;
describe.skipIf(!existsSync(DATA))("paired replay baseline vs 0.15 ATR location buffer", () => {
  it("runs both variants on identical inputs", async () => {
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
      const med = [...spreads].sort((a, b) => a - b)[Math.floor(spreads.length / 2)] ?? 0;
      const spec = { symbol, origin: "BROKER_REPORTED" as const, digits: raw.spec[symbol].digits, point, tick_size: point, contract_size: raw.spec[symbol].trade_contract_size, broker_utc_offset_ms: 0 };
      const out: Record<string, unknown> = { quality, replay: { start: new Date(bars.M5!.at(-maxBars)!.open_time).toISOString(), end: new Date(bars.M5!.at(-1)!.close_time).toISOString(), m5_bars: maxBars, warmup_m5: WARMUP_M5 }, spread_assumed: med };
      for (const [name, b] of [["baseline", 0], ["buffer_0_15", 0.15]] as const) {
        BUF.v = b; log.length = 0;
        const res = runAlignedReplay(symbol, spec, bars, { maxBars, costModel: { spread: med, source: "ASSUMED_FIXED", note: "median M5 spread", slippage: 0, latencyMs: 0 } });
        if (res.status !== "DONE") { out[name] = { status: "UNKNOWN", missing: res.missing }; continue; }
        const created = log.filter((x) => x.kind === "CREATE");
        const cnt = (f: (x: (typeof log)[number]) => boolean) => log.filter(f).length;
        const reasons: Record<string, number> = {};
        for (const x of log) if (x.kind === "UPDATE" && x.to !== x.from) { const k = `${x.from}->${x.to}:${x.reason ?? ""}`; reasons[k] = (reasons[k] ?? 0) + 1; }
        const savedIds = [...new Set(log.filter((x) => x.saved).map((x) => x.id))];
        const final = (id: string) => [...log].reverse().find((x) => x.id === id && x.kind === "UPDATE" && x.to !== x.from);
        const recs = res.rows.flatMap((r) => r.records.map((x) => ({ at: r.at, rec: x })));
        out[name] = {
          status: "DONE",
          created_total: created.length, created_reaction_confirmed: created.filter((x) => x.to === "REACTION_CONFIRMED").length, created_ready: created.filter((x) => x.to === "READY").length,
          promoted_ready: cnt((x) => x.kind === "UPDATE" && x.from === "REACTION_CONFIRMED" && x.to === "READY"),
          transitions: reasons,
          saved_setups: savedIds.map((id) => ({ id: id.replace(/_(\d+)$/, (_, t) => `_${new Date(+t * 1000).toISOString()}`), created_state: created.find((c) => c.id === id)?.to, saves: log.filter((x) => x.id === id && x.saved).map((x) => ({ at: new Date(x.at * 1000).toISOString(), key: x.key, close: x.close, atr: x.atr })), final: final(id) ? `${final(id)!.to}:${final(id)!.reason ?? ""}` : "STILL_ACTIVE_OR_CONSUMED" })),
          summary: res.summary, trades_simulated: res.trades.length,
          decisions_sample: recs.slice(0, 40).map((x) => ({ at: new Date(x.at).toISOString(), ...(x.rec as object) })),
        };
      }
      report[symbol] = out;
    }
    writeFileSync("/tmp/replay/location-buffer-report.json", JSON.stringify(report, null, 1));
    expect(report["orders_sent"]).toBe(0);
  }, 600_000);
});
