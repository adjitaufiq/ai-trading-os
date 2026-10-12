import { describe, expect, it } from "vitest";
import { AutomationStateTracker, buildChecklist, deriveStage } from "@/core/enginehost/automationState";
import type { ExecutionStatusView } from "@/core/enginehost/executionStatus";
import { captureChartSnapshots, renderChartSnapshotSvg } from "@/core/execution/demo/chartSnapshot";
import { buildTradeSnapshots } from "@/core/execution/demo/evaluation";
import type { DemoEvent } from "@/core/execution/demo/types";

const base: ExecutionStatusView = {
  schema: "engine-execution-status-v1", engine: "ONLINE", mode: "DEMO_EXECUTION", execution: "WAITING_SIGNAL", account: "PASS",
  mt5: "CONNECTED", shadow: "CLEAR", kill_switch: false, risk: "PASS", reconciliation: "CLEAN", signal: "READY", stale: false, blockers: [], checked_at: 1,
};

describe("automation state machine (LOCKED)", () => {
  it("defaults to MONITOR_ONLY and never arms without session arm", () => {
    expect(deriveStage({ ...base, engine: "OFFLINE" }, false).stage).toBe("MONITOR_ONLY");
    expect(deriveStage({ ...base, mode: "MONITOR_ONLY", mt5: "UNKNOWN", account: "UNKNOWN" }, false).stage).toBe("PAPER_READY");
    expect(deriveStage(base, false)).toEqual({ stage: "DEMO_CONNECTED", reason: "SESSION_ARM_REQUIRED" });
    expect(deriveStage(base, true).stage).toBe("DEMO_ARMED");
    expect(deriveStage({ ...base, execution: "ACTIVE" }, true).stage).toBe("DEMO_EXECUTION");
    expect(deriveStage({ ...base, kill_switch: true }, true).stage).toBe("DEMO_CONNECTED");
  });
  it("records each transition once", () => {
    const rec: string[] = [];
    const t = new AutomationStateTracker({ onTransition: (x) => rec.push(`${x.from}->${x.to}`) });
    t.observe({ ...base, engine: "OFFLINE" }, true, 1);
    t.observe({ ...base, engine: "OFFLINE" }, true, 2);
    const v = t.observe(base, true, 3);
    expect(rec).toEqual(["null->MONITOR_ONLY", "MONITOR_ONLY->DEMO_CONNECTED"]);
    expect(v.session_arm).toBe("NOT_ARMED");
    expect(v.verdict).toBe("EXECUTION_BLOCKED");
  });
  it("checklist has 9 items; any failure blocks", () => {
    const c = buildChecklist(base, true, false);
    expect(c).toHaveLength(9);
    expect(c.find((x) => x.key === "SESSION_ARM")!.state).toBe("FAIL");
    expect(buildChecklist(base, true, true).every((x) => x.state === "PASS")).toBe(true);
    expect(buildChecklist({ ...base, shadow: "BLOCKING" }, true, true).find((x) => x.key === "SHADOW_GUARD_CLEARED")!.state).toBe("FAIL");
  });
});

const intent = { signalId: "s1", planId: "p", symbol: "XAUUSD", direction: "BUY", plannedEntry: 100, stopLoss: 95, takeProfit: 110, rr: 2, closedBarAt: 3000,
  context: { regime: null, h4Bias: null, h1State: null, setup: "PULLBACK", decision: "READY", confidence: null, reasons: [], signalSource: {}, engineSnapshot: null } };
const events: DemoEvent[] = [
  { type: "SEND_ATTEMPT", at: 3500, signalId: "s1", symbol: "XAUUSD", data: { intent } },
  { type: "FILLED", at: 3600, signalId: "s1", symbol: "XAUUSD", data: { price: 100.5, ticket: 7 } },
];
const bars = [1000, 2000, 3000, 4000].map((t) => ({ open_time: t - 1000, close_time: t, open: 99, high: 102, low: 97, close: 101 }));
const src = { closedBars: () => bars, snr: () => ({ as_of: 1, zones: [{ type: "DEMAND", low: 99, high: 101, timeframe: "H1" }] }) };

describe("hybrid chart snapshot + journal", () => {
  it("captures PRE_ENTRY and ENTRY without future bars; image only at ENTRY", () => {
    const s = captureChartSnapshots(events, new Set(), src, "M5", 9999);
    expect(s.map((x) => x.phase)).toEqual(["PRE_ENTRY", "ENTRY"]);
    expect(s[0]!.bars.every((b) => b.t + 1000 <= 3000)).toBe(true);
    expect(renderChartSnapshotSvg(s[0]!)).toBeNull();
    expect(renderChartSnapshotSvg(s[1]!)).toContain("<svg");
    expect(captureChartSnapshots(events, new Set(["T-s1:PRE_ENTRY", ...s.map((x) => `${x.tradeId}:${x.phase}`)]), src, "M5", 1)).toEqual([]);
  });
  it("journal copies timeframe/setup/SNR zone and leaves confidence NOT_AVAILABLE", () => {
    const charts = captureChartSnapshots(events, new Set(), src, "M5", 9999);
    const [r] = buildTradeSnapshots(events, { engine_version: "e", strategy_version: "s", journal_version: "j" }, charts);
    expect(r!.journal.timeframe).toBe("M5");
    expect(r!.journal.setup).toBe("PULLBACK");
    expect(r!.journal.snr_zone).toMatchObject({ type: "DEMAND", match: "CONTAINS_ENTRY" });
    expect(r!.journal.confidence).toBeNull();
    expect(r!.journal.confidence_status).toBe("NOT_AVAILABLE");
  });
});
