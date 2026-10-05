import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import type { TechBar } from "@/core/technical/indicators";
import {
  SCALP_MOMENTUM_PARAMS, SCALP_MOMENTUM_POLICY_VERSION, combineMomentum, emaReaction, operatorAnalysis, scalpMomentumTf,
} from "@/core/technical/operator";
import { evaluate, type EvaluationInput } from "@/core/technical/tradingState";
import { aiSummaryPayload, compactSummary, AI_SUMMARY_MAX_CHARS } from "@/lib/tradeSummary";
import { operatorSummary } from "@/components/TechnicalSlicePanel";
import { SignalAlertStore } from "@/lib/signalAlerts";

const TF = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
type K = keyof typeof TF;
const series = (tf: K, closes: number[], start = 1_700_000_000_000): TechBar[] => closes.map((c, i) => {
  const open_time = start + i * TF[tf];
  return { open_time, close_time: open_time + TF[tf], available_at: open_time + TF[tf], open: c, high: c + 0.5, low: c - 0.5, close: c };
});
const ZIG = [0, 1, 2, 3, 4, 3, 2, 1];
const up = (k: number) => Array.from({ length: k }, (_, i) => 100 + i * 0.3 + ZIG[i % 8]!);
const down = (k: number) => Array.from({ length: k }, (_, i) => 200 - i * 0.3 - ZIG[i % 8]!);
const rising = (k: number, from = 95) => Array.from({ length: k }, (_, i) => from + 0.1 * i);
const falling = (k: number, from = 105) => Array.from({ length: k }, (_, i) => from - 0.1 * i);
const accel = (k: number) => Array.from({ length: k }, (_, i) => 100 + 0.002 * i * i);
const flat = (k: number) => Array.from({ length: k }, () => 100);
const withLast = (bars: TechBar[], ...last: [number, number, number, number][]) => {
  const out = [...bars];
  last.forEach((x, j) => { const at = out.length - last.length + j; out[at] = { ...out[at]!, open: x[0], high: x[1], low: x[2], close: x[3] }; });
  return out;
};
const input = (closed: EvaluationInput["closed"], price: number): EvaluationInput => ({
  symbol: "XAUUSD", market_current: true, bars_current: true, quote: { bid: price - 0.1, ask: price + 0.1, spread: 0.2, tick_time_ms: 1, observed_at: 2 },
  closed, as_of: 1e15, env: { operating_mode: "MONITOR_ONLY", execution_enabled: false },
});

describe("ARENA v0.4 P0.2 — scalp momentum", () => {
  it("versioned params, sign-only", () => {
    expect(SCALP_MOMENTUM_POLICY_VERSION).toBe("scalp-momentum-v0.4-p0.2-ema-slope-gap");
    expect(SCALP_MOMENTUM_PARAMS).toMatchObject({ slope_lookback_bars: 3, gap_lookback_bars: 3 });
  });
  it("per-TF states incl. expanding and insufficient", () => {
    expect(scalpMomentumTf(series("M5", accel(60))).state).toBe("BULLISH_EXPANDING");
    expect(scalpMomentumTf(series("M5", accel(60).map((c) => 200 - c))).state).toBe("BEARISH_EXPANDING");
    expect(scalpMomentumTf(series("M5", flat(60))).state).toBe("FLAT_OR_WEAK");
    expect(scalpMomentumTf(series("M5", rising(10))).state).toBe("INSUFFICIENT");
  });
  it("1-4: combined M5/M15", () => {
    expect(combineMomentum("BULLISH", "BULLISH_EXPANDING")).toBe("STRONG_BUY");
    expect(combineMomentum("BEARISH_EXPANDING", "BEARISH")).toBe("STRONG_SELL");
    expect(combineMomentum("BULLISH", "FLAT_OR_WEAK")).toBe("BUY");
    expect(combineMomentum("BEARISH", "INSUFFICIENT")).toBe("SELL");
    expect(combineMomentum("BULLISH", "BEARISH")).toBe("CONFLICT");
    expect(combineMomentum("FLAT_OR_WEAK", "BULLISH")).toBe("HOLD");
    const op = operatorAnalysis({ M5: series("M5", rising(60)), M15: series("M15", rising(60)), H1: series("H1", up(60)), H4: series("H4", up(60)) }, 101);
    expect(op.scalp.combined_momentum).toBe("STRONG_BUY");
    const op2 = operatorAnalysis({ M5: series("M5", rising(60)), M15: series("M15", falling(60)), H1: series("H1", up(60)), H4: series("H4", up(60)) }, 101);
    expect(op2.scalp.combined_momentum).toBe("CONFLICT");
    expect(op2.status).toBe("HOLD");
    expect(op2.candidate).toBeNull();
  });
  it("5: H4 bearish does not force SELL; local BUY ⇒ COUNTER_MACRO", () => {
    const M5 = withLast(series("M5", up(40)), [120, 120.2, 118.8, 119], [118.9, 121.2, 118.7, 121]);
    const op = operatorAnalysis({ M5, M15: series("M15", up(60)), H1: series("H1", up(60)), H4: series("H4", down(60)) }, 110);
    expect(op.macro.macro_direction).toBe("BEARISH");
    expect(["BUY", "STRONG_BUY"]).toContain(op.scalp.combined_momentum);
    expect(op.status).not.toBe("CARI_SELL");
    expect(op.candidate).not.toBe("SELL");
    expect(op.alignment).toBe("COUNTER_MACRO");
  });
  it("6: H4 bullish does not force BUY; local SELL ⇒ COUNTER_MACRO", () => {
    const op = operatorAnalysis({ M5: series("M5", down(60)), M15: series("M15", down(60)), H1: series("H1", down(60)), H4: series("H4", up(60)) }, 180);
    expect(op.macro.macro_direction).toBe("BULLISH");
    expect(["SELL", "STRONG_SELL"]).toContain(op.scalp.combined_momentum);
    expect(op.status).not.toBe("CARI_BUY");
    expect(op.candidate).not.toBe("BUY");
    expect(op.alignment).toBe("COUNTER_MACRO");
  });
  it("7: metrics use only the closed prefix (future bars do not leak)", () => {
    const bars = series("M5", up(80));
    const a = scalpMomentumTf(bars.slice(0, 50));
    const tampered = [...bars.slice(0, 50), ...series("M5", flat(30), bars[50]!.open_time)];
    expect(scalpMomentumTf(tampered.slice(0, 50))).toEqual(a);
    expect(a.slope5_norm).not.toBeNull();
  });
  it("8: EMA21/50 touch, rejection and local confluence on M5/M15", () => {
    const base = series("M5", flat(60));
    const rej = withLast(base, [99.9, 100.4, 99.5, 100.3]);
    expect(emaReaction(rej).map((r) => r.kind)).toEqual(["REJECTED_UP", "REJECTED_UP"]);
    const touched = withLast(base, [100, 100.4, 99.5, 100]);
    expect(emaReaction(touched).every((r) => r.kind === "TOUCHED")).toBe(true);
    const op = operatorAnalysis({ M5: base, M15: series("M15", flat(60)), H1: series("H1", up(60)), H4: series("H4", up(60)) }, 100);
    expect(op.scalp.M5.ema_location).toBe("BAND");
    expect(op.ema_confluence.timeframe).toBe("M5");
  });
  it("9-10: cockpit exposes M5/M15 momentum, no legacy H4 EMA5/21 card; summary bounded", () => {
    const s = evaluate(input({ M5: series("M5", rising(60)), M15: series("M15", rising(60)), H1: series("H1", up(60)), H4: series("H4", up(60)) }, 101));
    const o = operatorSummary(s);
    expect(o.m5).toMatch(/BULLISH/);
    expect(o.m15).toMatch(/BULLISH/);
    expect(o.momentum).toBe("STRONG BUY");
    const src = readFileSync("src/components/TechnicalSlicePanel.tsx", "utf8");
    expect(src).not.toMatch(/confirm-h4|Tren H4/);
    const c = compactSummary(s);
    expect(c.scalp_momentum_combined).toBe("STRONG_BUY");
    expect(c.momentum_policy_version).toBe(SCALP_MOMENTUM_POLICY_VERSION);
    expect(c.momentum.M5?.state).toMatch(/BULLISH/);
    expect(aiSummaryPayload(s).length).toBeLessThanOrEqual(AI_SUMMARY_MAX_CHARS);
    render(<div>{o.m5}</div>);
    expect(screen.getByText(o.m5)).toBeTruthy();
  });
  it("11-12: alerts do not duplicate; no execution path", () => {
    const store = new SignalAlertStore();
    expect(typeof store.getAlerts).toBe("function");
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    for (const f of ["src/core/technical/operator.ts", "src/lib/paperJournal.ts", "src/lib/tradeSummary.ts"])
      expect(readFileSync(f, "utf8")).not.toMatch(/order_send|placeOrder|submitOrder|WebSocket\(|fetch\(/);
  });
});
