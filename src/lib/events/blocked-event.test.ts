import { describe, expect, it, vi } from "vitest";
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/assistant/llm/gateway.server", () => ({ selectLlmAdapter: () => ({ create: () => ({ model: {} }) }) }));
import { demoToRows } from "./events.server";
import { composeAlert } from "@/lib/assistant/telegram.server";

describe("BLOCK_COUNTER_PRIMARY_BIAS event → engine_events row → Telegram", () => {
  const audit = { attemptedSide: "BUY", primaryBias: "SELL", counterTrendCondition: "BULLISH_PULLBACK", timeframeConflict: { H4: "SELL", H1: "LH_LL", attempted: "BUY", source: "TECHNICAL_H4_CLOSED" } };
  const ev = { type: "BLOCKED", at: Date.UTC(2026, 9, 9), signalId: "s1", symbol: "BTCUSD", detail: "BLOCK_COUNTER_PRIMARY_BIAS primaryBias=SELL attemptedSide=BUY counterTrend=BULLISH_PULLBACK", data: { reason: "BLOCK_COUNTER_PRIMARY_BIAS", intent: { direction: "BUY" }, audit } };
  it("maps audit into timeframe_context and block_reason", () => {
    const [row] = demoToRows([ev as never]);
    expect(row!.block_reason!.startsWith("BLOCK_COUNTER_PRIMARY_BIAS")).toBe(true);
    expect(row!.timeframe_context).toMatchObject(audit);
  });
  it("Telegram EXECUTION BLOCKED shows the block_reason", () => {
    const [row] = demoToRows([ev as never]);
    const msg = composeAlert({ ...row!, stage: row!.stage } as never, null);
    expect(msg).toContain("EXECUTION BLOCKED");
    expect(msg).toContain("BLOCK_COUNTER_PRIMARY_BIAS");
  });
});
