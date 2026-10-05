import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXECUTION_ENABLED, OPERATING_MODE } from "@/core/contracts";
import { ema, type TechBar } from "@/core/technical/indicators";
import { ARCHITECTURE_VERSION, macroAlignment, macroDirectionOf, operatorAnalysis } from "@/core/technical/operator";
import { evaluate, type EvaluationInput } from "@/core/technical/tradingState";
import { compactSummary, aiSummaryPayload, AI_SUMMARY_MAX_CHARS } from "@/lib/tradeSummary";

const TF = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 } as const;
type K = keyof typeof TF;
const series = (tf: K, closes: number[], start = 1_700_000_000_000): TechBar[] => closes.map((c, i) => {
  const open_time = start + i * TF[tf];
  return { open_time, close_time: open_time + TF[tf], available_at: open_time + TF[tf], open: c, high: c + 0.5, low: c - 0.5, close: c };
});
const ZIG = [0, 1, 2, 3, 4, 3, 2, 1];
const up = (k: number) => Array.from({ length: k }, (_, i) => 100 + i * 0.3 + ZIG[i % 8]!);
const withLast = (bars: TechBar[], ...last: [number, number, number, number][]) => {
  const out = [...bars];
  last.forEach((x, j) => { const at = out.length - last.length + j; out[at] = { ...out[at]!, open: x[0], high: x[1], low: x[2], close: x[3] }; });
  return out;
};
const input = (closed: EvaluationInput["closed"], price: number): EvaluationInput => ({
  symbol: "XAUUSD", market_current: true, bars_current: true, quote: { bid: price - 0.1, ask: price + 0.1, spread: 0.2, tick_time_ms: 1, observed_at: 2 },
  closed, as_of: 1e15, env: { operating_mode: "MONITOR_ONLY", execution_enabled: false },
});

describe("ARENA v0.4 P0.1 — macro/scalp split", () => {
  it("alignment classification", () => {
    expect(macroAlignment("BUY", "BULLISH")).toBe("WITH_MACRO");
    expect(macroAlignment("BUY", "BEARISH")).toBe("COUNTER_MACRO");
    expect(macroAlignment("SELL", "BULLISH")).toBe("COUNTER_MACRO");
    expect(macroAlignment("BUY", "NEUTRAL_OR_MIXED")).toBe("NEUTRAL_MACRO");
    expect(macroAlignment("BUY", "INSUFFICIENT")).toBe("NOT_APPLICABLE");
    expect(macroAlignment(null, "BULLISH")).toBe("NOT_APPLICABLE");
    expect(macroDirectionOf("MIXED")).toBe("NEUTRAL_OR_MIXED");
  });

  it("H4 bullish + local BUY candidate ⇒ WITH_MACRO, exposes macro + scalp read models", () => {
    const H1 = series("H1", up(60));
    const price = (ema(H1, 21) as { value: number }).value;
    const m5 = withLast(series("M5", up(40)), [120, 120.2, 118.8, 119], [118.9, 121.2, 118.7, 121]);
    const s = evaluate(input({ M5: m5, M15: series("M15", up(60)), H1, H4: series("H4", up(60)) }, price));
    const op = s.operator!;
    expect(op.architecture_version).toBe(ARCHITECTURE_VERSION);
    expect(op.candidate).toBe("BUY");
    expect(op.macro.macro_direction).toBe("BULLISH");
    expect(op.alignment).toBe("WITH_MACRO");
    expect(op.scalp.M5.ema5.status).toBe("OK");
    expect(op.scalp.trigger).toBe(op.trigger);
    const c = compactSummary(s);
    expect(c).toMatchObject({ macro_direction: "BULLISH", alignment: "WITH_MACRO", h1_context: op.h1_context });
    expect(aiSummaryPayload(s).length).toBeLessThanOrEqual(AI_SUMMARY_MAX_CHARS);
  });

  it("H4 mixed (range) local candidate ⇒ NEUTRAL_MACRO", () => {
    const range = (k: number) => Array.from({ length: k }, (_, i) => 100 + 2 * ZIG[i % 8]!);
    const base = { M15: series("M15", range(60)), H1: series("H1", range(60)), H4: series("H4", range(60)) };
    const op = operatorAnalysis({ ...base, M5: withLast(series("M5", range(60)), [99.8, 100.1, 98.6, 100]) }, 100);
    expect(op.macro.macro_direction).toBe("NEUTRAL_OR_MIXED");
    expect(op.candidate).toBe("BUY");
    expect(op.alignment).toBe("NEUTRAL_MACRO");
  });

  const range = (k: number) => Array.from({ length: k }, (_, i) => 100 + 2 * ZIG[i % 8]!);
  const down = (k: number) => Array.from({ length: k }, (_, i) => 200 - i * 0.3 - ZIG[i % 8]!);
  const trig = () => withLast(series("M5", up(40)), [120, 120.2, 118.8, 119], [118.9, 121.2, 118.7, 121]);

  it("H1 MIXED alone does not hard-veto a valid local scalp candidate (pre-P0.1 this was H1_MIXED_NOT_RETURNING)", () => {
    const M15 = series("M15", up(60));
    const price = (ema(M15, 21) as { value: number }).value;
    const s = evaluate(input({ M5: trig(), M15, H1: series("H1", range(60)), H4: series("H4", up(60)) }, price));
    const op = s.operator!;
    expect(op.h4_primary).toBe("UP");
    expect(op.h1_context).toBe("MIXED");
    expect(op.checks.context).toBe(false); // legacy flag still reports H1 not aligned
    expect(op.candidate).toBe("BUY");
    expect(op.alignment).toBe("WITH_MACRO");
    expect(s.entry.state).toBe("LONG_CANDIDATE");
    expect(s.execution.state).toBe("BLOCKED");
  });

  it("H4 bearish + local BUY at support with H1 pullback ⇒ COUNTER_MACRO candidate", () => {
    const s = evaluate(input({ M5: trig(), M15: series("M15", up(60)), H1: series("H1", range(60)), H4: series("H4", down(60)) }, 100));
    const op = s.operator!;
    expect(op.macro.macro_direction).toBe("BEARISH");
    expect(op.h1_context).toBe("PULLBACK_AGAINST_H4");
    expect(op.location).toBe("AT_SUPPORT");
    expect(op.candidate).toBe("BUY");
    expect(op.alignment).toBe("COUNTER_MACRO");
    expect(compactSummary(s).alignment).toBe("COUNTER_MACRO");
  });

  it("no lookahead: future bars do not change analysis of the prefix; safety unchanged", () => {
    const H1 = series("H1", up(60));
    const a = operatorAnalysis({ M5: series("M5", up(40)), M15: series("M15", up(60)), H1: H1.slice(0, 50), H4: series("H4", up(60)) }, 110);
    const b = operatorAnalysis({ M5: series("M5", up(40)), M15: series("M15", up(60)), H1: H1.slice(0, 50), H4: series("H4", up(60)) }, 110);
    expect(a).toEqual(b);
    for (const z of a.macro.major_zones.H1) expect(z.latest_touch_at).toBeLessThanOrEqual(H1[49]!.available_at);
    expect(OPERATING_MODE).toBe("MONITOR_ONLY");
    expect(EXECUTION_ENABLED).toBe(false);
    for (const f of ["src/core/technical/operator.ts", "src/lib/paperJournal.ts", "src/lib/tradeSummary.ts"])
      expect(readFileSync(f, "utf8")).not.toMatch(/order_send|placeOrder|submitOrder|BrokerGatewayClient|WebSocket\(/);
  });
});
