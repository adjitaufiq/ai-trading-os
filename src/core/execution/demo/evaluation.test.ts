import { describe, expect, it } from "vitest";
import { DemoExecutionBridge } from "./DemoExecutionBridge";
import { buildTradeSnapshots, EVAL_STAGES, stressCounters, toEvaluationCsv, EVAL_CSV_COLUMNS } from "./evaluation";
import type { DemoAccountIdentity, DemoCloseDeal, DemoExecGatewayPort, DemoOrderIntent } from "./types";

const V = { engine_version: "e+abc", strategy_version: "s", journal_version: "eval-journal-v1" };
const acct: DemoAccountIdentity = { login: 111, server: "Exness-MT5Trial", tradeMode: "DEMO", balance: 10_000, equity: 10_000, currency: "USD" };
const ed = { gatePolicyVersion: "g1", decision: "ALLOW" as const, reason: "ARENA CARI_BUY same side", arenaStatus: "CARI_BUY", candidateDirection: "BUY" as const, signalId: "s1", decidedAt: 1, primaryBias: "BUY" as const, m1bBias: "H4_BULLISH", m15Structure: "UP", m15StructureShift: null, priceLocation: "AT_SUPPORT", locationTier: "H1", trigger: "ENGULF", reactionQuality: "STRONG", plannedEntry: 2000, stopLoss: 1995, takeProfit: 2010, plannedRr: 2, lot: 0.1, riskUSD: 50 };
const intent = (id: string): DemoOrderIntent => ({ signalId: id, planId: "p", symbol: "XAUUSD", direction: "BUY", plannedEntry: 2000, stopLoss: 1995, takeProfit: 2010, rr: 2, closedBarAt: 1,
  context: { regime: "TRENDING", h4Bias: "BULLISH", primaryBias: "BUY", h1State: "PULLBACK", setup: "PULLBACK_BUY", decision: "READY", confidence: 80, reasons: [], signalSource: {}, engineSnapshot: null, entryDecision: { ...ed, signalId: id } } });

function rig(deal: () => DemoCloseDeal | null, lines: string[] = []) {
  let open = false; let down = false; let sent = 0; let t = Date.UTC(2026, 9, 12, 9);
  const gw: DemoExecGatewayPort = {
    account: async () => acct,
    symbol: async (s) => ({ symbol: s, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, marginPerLot: 0 }),
    positions: async () => { if (down) throw new Error("disconnected"); return open ? [{ ticket: 99, symbol: "XAUUSD", comment: "s1" }] : []; },
    closeDeal: async () => deal(),
    sendOrder: async () => { sent++; open = true; return { status: "FILLED", ticket: 99, price: 2000, retcode: 10009, comment: "done" }; },
  };
  const mk = () => new DemoExecutionBridge({ mode: "DEMO_STRESS_TEST", gateway: gw, whitelist: { logins: [111], servers: ["Exness-MT5Trial"] }, killSwitch: () => false, now: () => (t += 1000), store: { readLines: () => lines, append: (l) => lines.push(l) } });
  return { lines, mk, close: () => { open = false; }, setDown: (v: boolean) => { down = v; }, sent: () => sent };
}
const events = (lines: string[]) => lines.map((l) => JSON.parse(l));

describe("Phase 4B evaluation journal", () => {
  it("open → close → journal complete with full snapshot and versions", async () => {
    const r = rig(() => ({ positionTicket: 99, price: 2010, profit: 100, time: Date.UTC(2026, 9, 12, 10), reason: "TP" }));
    const b = r.mk(); await b.handle(intent("s1")); r.close(); await b.sync();
    const [s] = buildTradeSnapshots(events(r.lines), V);
    expect(s!.lifecycle.map((x) => x.stage)).toEqual(EVAL_STAGES);
    expect(s!.lifecycle_complete).toBe(true);
    expect(s).toMatchObject({ symbol: "XAUUSD", direction: "BUY", account_balance: 10_000, risk_percent: 0.5, lot_size: 0.1, stop_loss: 1995, take_profit: 2010,
      market: { h4_bias: "BUY", h1_state: "PULLBACK", m15_structure: "UP", m5_trigger: "ENGULF" },
      technical: { arena_state: "CARI_BUY", m1b_state: "READY", snr_location: "AT_SUPPORT" },
      decision: { decision_status: "APPROVED", approval_reason: "ARENA CARI_BUY same side" },
      execution: { execution_status: "FILLED", fill_price: 2000, broker_ticket: 99 },
      result: { close_price: 2010, close_reason: "TP", close_source: "BROKER_DEAL_HISTORY", profit_loss: 100, rr_result: 2, outcome: "WIN" }, versions: V });
  });
  it("SL hit → loss recorded with -1R", async () => {
    const r = rig(() => ({ positionTicket: 99, price: 1995, profit: -50, time: Date.UTC(2026, 9, 12, 10), reason: "SL" }));
    const b = r.mk(); await b.handle(intent("s1")); r.close(); await b.sync();
    const [s] = buildTradeSnapshots(events(r.lines), V);
    expect(s!.result).toMatchObject({ close_reason: "SL", profit_loss: -50, rr_result: -1, outcome: "LOSS" });
    expect(s!.lifecycle_complete).toBe(true);
  });
  it("broker disconnect: no false close, stays OPEN, then closes after reconnect", async () => {
    const r = rig(() => ({ positionTicket: 99, price: 2010, profit: 100, time: Date.UTC(2026, 9, 12, 10), reason: "TP" }));
    const b = r.mk(); await b.handle(intent("s1")); r.close(); r.setDown(true); await b.sync();
    expect(buildTradeSnapshots(events(r.lines), V)[0]!.result.outcome).toBe("OPEN");
    r.setDown(false); await b.sync();
    expect(buildTradeSnapshots(events(r.lines), V)[0]!.result.outcome).toBe("WIN");
  });
  it("restart keeps lifecycle and duplicate protection", async () => {
    const r = rig(() => null);
    await r.mk().handle(intent("s1"));
    const b2 = r.mk(); // restart from the same append-only log
    expect(buildTradeSnapshots(events(r.lines), V)[0]!.lifecycle.map((x) => x.stage)).toContain("POSITION_MONITORING");
    const again = await b2.handle(intent("s1"));
    expect(again.type).toBe("BLOCKED"); expect(r.sent()).toBe(1);
  });
  it("CSV export and descriptive counters", async () => {
    const r = rig(() => ({ positionTicket: 99, price: 2010, profit: 100, time: Date.UTC(2026, 9, 12, 10), reason: "TP" }));
    const b = r.mk(); await b.handle(intent("s1")); r.close(); await b.sync();
    const rows = buildTradeSnapshots(events(r.lines), V);
    const csv = toEvaluationCsv(rows).trim().split("\n");
    expect(csv[0]).toBe(EVAL_CSV_COLUMNS.join(",")); expect(csv).toHaveLength(2);
    expect(stressCounters(rows)).toMatchObject({ total_demo_trades: 1, completed_trades: 1, open_trades: 0, win_rate: 1, average_rr: 2, max_drawdown: 0, incomplete_lifecycles: 0 });
  });
  it("trade without risk plan is flagged NO_RISK", () => {
    const rows = buildTradeSnapshots([{ type: "SEND_ATTEMPT", at: 1, signalId: "x", symbol: "XAUUSD", data: { intent: intent("x") } }], V);
    expect(rows[0]!.violations).toContain("NO_RISK"); expect(rows[0]!.lifecycle_complete).toBe(false);
  });
});
