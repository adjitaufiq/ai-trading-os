import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import {
  BAD_RR_REASON, SCALP_STOP_PARAMS, SCALP_STOP_POLICY_VERSION, TARGET_CLAMP_PARAMS, TARGET_CLAMP_POLICY_VERSION,
  buildSidePlan, deriveRadarPlan, deriveSignalLifecycle, planInvariantHolds, type EvaluationInput, type TradingSnapshot,
} from "@/core/technical/tradingState";
import type { TechBar } from "@/core/technical/indicators";
import { openPaper, markPaper } from "@/lib/paperJournal";
import { SignalAlertStore } from "@/lib/signalAlerts";
import { engineSignalOf } from "@/lib/tradeSummary";
import { RadarPlanView } from "@/components/TechnicalSlicePanel";
import type { KV } from "@/lib/paperJournal";

const OK = (value: number) => ({ status: "OK", value });
const NA = { status: "INSUFFICIENT_HISTORY" };
const sw = (kind: "LOW" | "HIGH", price: number) => ({ kind, price });
const ev = (m15: ReturnType<typeof sw>[], m5: ReturnType<typeof sw>[] = [], h1: ReturnType<typeof sw>[] = [sw("LOW", 50), sw("HIGH", 150)]) => ({
  M5: { rsi14: NA, structure: { swings: m5 } }, M15: { rsi14: NA, atr14: OK(4), structure: { swings: m15 } }, H1: { rsi14: NA, structure: { swings: h1 } }, H4: { structure: { swings: [] } },
}) as never;
const z = (tf: string, low: number, high: number, role: "SUPPORT" | "RESISTANCE") => ({ source_tf: tf, low, high, center: (low + high) / 2, touches: 2, role, distance: 1 });
const op = (zones: { M5?: unknown[]; M15?: unknown[]; H1?: unknown[]; H4?: unknown[] } = {}, status = "CARI_SELL", local: unknown[] = []) => ({
  status, reason: "TRIGGER_PENDING", zones: { M5: [], M15: [], H1: [], H4: [], ...zones }, ema_confluence: { zone: "NOT_NEAR", timeframe: null },
  patterns: { M5: { bullish: [], bearish: [] }, M15: { bullish: [], bearish: [] } },
  scalp: { local_zones: local, M15: { ema21: NA, ema50: NA, atr14: NA, ema_location: "NOT_NEAR", ema_reaction: [] }, M5: { ema21: NA, ema50: NA, atr14: NA, ema_location: "NOT_NEAR", ema_reaction: [] } },
}) as never;
const memKV = (): KV => { const d = new Map<string, string>(); return { getItem: (k) => d.get(k) ?? null, setItem: (k, v) => { d.set(k, v); } }; };

describe("P0.6 scalp stop (local confirmed swing)", () => {
  it("versioned params", () => {
    expect(SCALP_STOP_POLICY_VERSION).toBe("scalp-stop-v0.4-local-swing-v1");
    expect(SCALP_STOP_PARAMS).toMatchObject({ atr_buffer_multiple: 0.25, anchor_priority: ["M15", "M5"], authority: "RESEARCH_REQUIRED_BASELINE" });
    expect(TARGET_CLAMP_POLICY_VERSION).toBe("target-clamp-v0.4-structural-v1");
    expect(TARGET_CLAMP_PARAMS).toMatchObject({ structural_buffer_atr_m15: 0.2, min_rr_for_actionable: 1, eligible_target_timeframes: ["M15", "H1", "H4"] });
  });
  it("1. SELL SL = latest confirmed M15 swing HIGH above entry + 0.25 ATR (not H1)", () => {
    const p = buildSidePlan("SELL", 100, ev([sw("HIGH", 103), sw("HIGH", 98), sw("HIGH", 105)]));
    expect(p).toMatchObject({ ok: true, anchor_timeframe: "M15", anchor_kind: "CONFIRMED_LOCAL_SWING_HIGH", anchor_price: 105, sl: 106, risk: 6, atr_buffer: 1 });
  });
  it("2. M15 unavailable ⇒ confirmed M5 HIGH", () => {
    expect(buildSidePlan("SELL", 100, ev([sw("HIGH", 99)], [sw("HIGH", 102)]))).toMatchObject({ ok: true, anchor_timeframe: "M5", anchor_price: 102, sl: 103 });
  });
  it("3. BUY mirror", () => {
    expect(buildSidePlan("BUY", 100, ev([sw("LOW", 96)]))).toMatchObject({ ok: true, anchor_timeframe: "M15", anchor_kind: "CONFIRMED_LOCAL_SWING_LOW", sl: 95, risk: 5 });
    expect(buildSidePlan("BUY", 100, ev([], [sw("LOW", 97)]))).toMatchObject({ anchor_timeframe: "M5", sl: 96 });
  });
  it("4. no local protective swing ⇒ NOT_AVAILABLE, no silent H1 fallback", () => {
    expect(buildSidePlan("BUY", 100, ev([sw("LOW", 101)], []))).toEqual({ ok: false, reason: "LOCAL_SCALP_SWING_LOW_UNAVAILABLE" });
    expect(buildSidePlan("SELL", 100, ev([], []))).toEqual({ ok: false, reason: "LOCAL_SCALP_SWING_HIGH_UNAVAILABLE" });
  });
});

describe("P0.6 structural target clamp", () => {
  it("5/7/8/9. SELL target = support.high + 0.20 ATR; raw preserved; clamps TP2 between 1R and 2R", () => {
    // entry 100, SL 106 (R=6); support high 89 ⇒ buffered 89.8 ⇒ reward 10.2 ⇒ 1.7R
    const p = buildSidePlan("SELL", 100, ev([sw("HIGH", 105)]), op({ H1: [z("H1", 87, 89, "SUPPORT")] }));
    if (!p.ok) throw new Error(p.reason);
    expect(p.raw_tp1).toBe(94); expect(p.raw_tp2).toBe(88);
    expect(p.structural_target_raw).toBe(89); expect(p.structural_target_buffered).toBeCloseTo(89.8);
    expect(p.tp2).toBeCloseTo(89.8); expect(p.tp1).toBe(94);
    expect(p.final_rr).toBeCloseTo(1.7); expect(p.economics_status).toBe("OK");
    expect(planInvariantHolds("SELL", p.sl, p.entry, p.tp1, p.tp2)).toBe(true);
  });
  it("6. BUY target = resistance.low − 0.20 ATR; far wall ⇒ raw 2R kept", () => {
    const p = buildSidePlan("BUY", 100, ev([sw("LOW", 96)]), op({ M15: [z("M15", 108, 109, "RESISTANCE")] }));
    if (!p.ok) throw new Error(p.reason);
    expect(p.structural_target_buffered).toBeCloseTo(107.2); expect(p.tp2).toBeCloseTo(107.2); expect(p.final_rr).toBeCloseTo(1.44);
    const far = buildSidePlan("BUY", 100, ev([sw("LOW", 96)]), op({ H4: [z("H4", 130, 131, "RESISTANCE")] }));
    expect(far).toMatchObject({ tp2: 110, final_rr: 2, economics_status: "OK" });
  });
  it("M5 zones are not eligible targets; no target ⇒ NO_STRUCTURAL_TARGET (not a veto)", () => {
    expect(buildSidePlan("BUY", 100, ev([sw("LOW", 96)]), op({ M5: [z("M5", 101, 102, "RESISTANCE")] }))).toMatchObject({ economics_status: "NO_STRUCTURAL_TARGET", tp2: 110, tp1: 105 });
  });
  it("10. target < 1R ⇒ BAD_RR, TP1 null, raw kept", () => {
    const p = buildSidePlan("SELL", 100, ev([sw("HIGH", 105)]), op({ M15: [z("M15", 95, 97, "SUPPORT")] }));
    expect(p).toMatchObject({ ok: true, economics_status: "BAD_RR", tp1: null, raw_tp1: 94, raw_tp2: 88 });
    if (p.ok) { expect(p.tp2).toBeCloseTo(97.8); expect(p.final_rr).toBeCloseTo(2.2 / 6); expect(p.economics_reason).toContain(BAD_RR_REASON); }
    const blocked = buildSidePlan("SELL", 100, ev([sw("HIGH", 105)]), op({ M15: [z("M15", 98, 99.5, "SUPPORT")] }));
    expect(blocked).toMatchObject({ economics_status: "BAD_RR", tp1: null, tp2: null, final_rr: 0 });
  });
  it("BTC screenshot-like SELL: local SL, wall at ~85166 ⇒ BAD_RR, never the raw 1R", () => {
    const p = buildSidePlan("SELL", 85240, { ...(ev([sw("HIGH", 85320)]) as object), M15: { atr14: OK(60), structure: { swings: [sw("HIGH", 85320)] } } } as never, op({ M15: [z("M15", 85100, 85166, "SUPPORT")] }));
    if (!p.ok) throw new Error(p.reason);
    expect(p.anchor_timeframe).toBe("M15"); expect(p.sl).toBe(85335); // not the H1 86548
    expect(p.economics_status).toBe("BAD_RR"); expect(p.tp1).toBeNull(); expect(p.tp2).toBeCloseTo(85178);
  });
});

describe("P0.6 actionable veto, radar, alerts", () => {
  const M5 = 300_000;
  const bars = Array.from({ length: 11 }, (_, k): TechBar => ({ open_time: k * M5, close_time: (k + 1) * M5, available_at: (k + 1) * M5, open: 100, high: 101, low: 99, close: 100.5 }));
  const input = (bid: number, ask: number): EvaluationInput => ({ symbol: "XAUUSD", market_current: true, bars_current: true, quote: { bid, ask, spread: ask - bid, tick_time_ms: 1, observed_at: 1 }, closed: { M5: bars, M15: [], H1: [], H4: [] }, as_of: 1, env: { operating_mode: "MONITOR_ONLY", execution_enabled: false } });
  const opT = (zones: object) => ({ candidate: "SELL", status: "CARI_SELL", reason: "R", alignment: "NEUTRAL_MACRO", location: "AT_RESISTANCE",
    trigger_bar: { timeframe: "M5", open_time: 10 * M5, available_at: 11 * M5, patterns: ["BEARISH_ENGULFING"] }, scalp: { combined_momentum: "SELL", local_zones: [] },
    patterns: { M5: { direction: "NONE", bar_available_at: null }, M15: { direction: "NONE", bar_available_at: null } }, zones: { M5: [], M15: [], H1: [], H4: [], ...zones } }) as never;
  const ACTIVE = { state: "ACTIVE" as const, reason: "T" };

  it("13. frozen READY plan does not move on later ATR/SR changes", () => {
    const s0 = deriveSignalLifecycle(input(100, 100.2), null, ACTIVE, opT({ M15: [z("M15", 85, 86, "SUPPORT")] }), ev([sw("HIGH", 105)]));
    const plan0 = s0.origin!.origin_plan!;
    const s1 = deriveSignalLifecycle(input(100, 100.2), s0, ACTIVE, opT({ M15: [z("M15", 97, 98, "SUPPORT")] }), { ...(ev([sw("HIGH", 101)]) as object), M15: { atr14: OK(9), structure: { swings: [sw("HIGH", 101)] } } } as never);
    expect(s1.state).toBe("READY"); expect(s1.origin!.origin_plan).toBe(plan0);
    expect(plan0).toMatchObject({ sl: 106, tp2: 88, economics_status: "OK" }); expect(s1.origin!.initial_r).toBe(6);
  });
  it("12. RADAR before trigger already shows BAD_RR", () => {
    const o = op({ M15: [z("M15", 95, 97, "SUPPORT")] }, "CARI_SELL", [z("M15", 99, 101, "RESISTANCE")]);
    const r = deriveRadarPlan({ state: "WAIT", reason: "NO_TRIGGER" }, { bid: 100, ask: 100.2, spread: 0.2, tick_time_ms: 1, observed_at: 1 }, ev([sw("HIGH", 105)]), o, { status: "NOT_AVAILABLE", policy_version: "reference-plan-v3-p0.6-local-swing-structural-clamp", reason: "W" });
    expect(r).toMatchObject({ mode: "RADAR", status: "AVAILABLE", economics_status: "BAD_RR", reason: BAD_RR_REASON, tp1: null, anchor_timeframe: "M15" });
    render(<RadarPlanView radar={r} signal="HOLD" entry={null} />);
    expect(screen.getByTestId("radar-status")).toHaveTextContent("HOLD · BAD R:R — S/R TERLALU DEKAT");
    expect(screen.getByTestId("econ-badge")).toHaveTextContent("BAD R:R");
    expect(screen.getByTestId("raw-targets")).toHaveTextContent("RAW teoretis");
    expect(screen.getByTestId("sl-source")).toHaveTextContent("M15 swing high + 0.25 ATR");
  });
  it("10/11. BAD_RR technical READY ⇒ engine HOLD and no BUY/SELL alert", () => {
    const vetoed = { symbol: "XAUUSD", availability: "AVAILABLE", quote: { bid: 100, ask: 101 }, entry: { state: "WAIT", reason: BAD_RR_REASON }, signal: { state: "READY", reason: "M5" }, reference_plan: { status: "AVAILABLE", side: "SELL", economics_status: "BAD_RR" }, operator: { alignment: "NEUTRAL_MACRO" } } as unknown as TradingSnapshot;
    expect(engineSignalOf(vetoed)).toBe("HOLD");
    const st = new SignalAlertStore(memKV());
    st.observe({ ...vetoed, entry: { state: "WAIT", reason: "X" } } as TradingSnapshot, "XAUUSD", 1);
    expect(st.observe(vetoed, "XAUUSD", 2)).toBeNull();
    expect(st.getAlerts()).toHaveLength(0);
  });
  it("evaluate() vetoes actionable entry on BAD_RR (source contract)", () => {
    const src = readFileSync("src/core/technical/tradingState.ts", "utf8");
    expect(src).toMatch(/badRr \? \{ state: "WAIT", reason: BAD_RR_REASON \}/);
  });
});

describe("P0.6 paper + backtest", () => {
  const snap = { symbol: "BTCUSD", availability: "AVAILABLE", quote: { bid: 100, ask: 100.2 }, evidence: ev([sw("HIGH", 105), sw("LOW", 95)]),
    operator: op({ M15: [z("M15", 95.5, 97, "SUPPORT")] }, "CARI_SELL"), entry: { state: "WAIT", reason: "T" }, signal: { state: "WAITING" }, reference_plan: { status: "NOT_AVAILABLE", reason: "T" },
    versions: { technical_engine_version: "t" }, why: [] } as unknown as TradingSnapshot;
  it("14/15. manual paper during BAD_RR allowed, tagged, invariants hold, engine unchanged", () => {
    const before = JSON.stringify(snap);
    const p = openPaper({ symbol: "BTCUSD", side: "SELL", quote: { bid: 100, ask: 100.2 }, now: 1, snapshot: snap, id: "a" });
    expect(p).toMatchObject({ entry: 100, sl: 106, tp1: null, economics_status: "BAD_RR", economic_veto_at_open: BAD_RR_REASON, anchor_timeframe: "M15", action_source: "MANUAL_EARLY" });
    expect(p.tp2!).toBeLessThan(p.entry); expect(p.sl!).toBeGreaterThan(p.entry);
    expect(p.policy_versions).toMatchObject({ scalp_stop_policy_version: SCALP_STOP_POLICY_VERSION, target_clamp_policy_version: TARGET_CLAMP_POLICY_VERSION });
    expect(markPaper(p, { bid: p.tp2! - 0.1, ask: p.tp2! }, 2)).toMatchObject({ status: "CLOSED", exit_reason: "TP2" });
    const b = openPaper({ symbol: "BTCUSD", side: "BUY", quote: { bid: 100, ask: 100.2 }, now: 1, snapshot: snap, id: "b" });
    expect(b.sl!).toBeLessThan(b.entry);
    expect(JSON.stringify(snap)).toBe(before); expect(engineSignalOf(snap)).toBe("HOLD");
  });
  it("16. backtest skips BAD_RR actionable trades and uses final_rr for wins", () => {
    const src = readFileSync("src/core/technical/backtest.ts", "utf8");
    expect(src).toContain('snap.entry.reason === "BAD_RR_AFTER_STRUCTURAL_CLAMP"');
    expect(src).toContain('outcome === "WIN" ? plan.final_rr');
    expect(src).not.toMatch(/outcome === "WIN" \? 2/);
  });
});
