import { afterEach, describe, expect, it, vi } from "vitest";
import { limitTelegramHtml, markdownToTelegramHtml, readableEngineText, telegramHtmlToPlainText } from "./telegramFormat";

vi.mock("ai", () => ({ generateText: vi.fn(async () => ({ text: "**Ringkasan**\n- - `STAND_ASIDE`\nLevel <belum tersedia>" })) }));
vi.mock("./llm/gateway.server", () => ({ selectLlmAdapter: () => ({ create: () => ({ model: {} }) }) }));
vi.mock("./context.server", () => ({ buildLiveContext: vi.fn(async (scope: string) => `LIVE_CONTEXT ${scope}`) }));
vi.mock("../memory/context.server", () => ({ buildMemoryContext: vi.fn(async () => "MEMORY_CONTEXT: 0 samples") }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { answerQuestion, composeAlert, sendTelegramMessage, type AlertEvent } from "./telegram.server";
import { buildLiveContext } from "./context.server";
import { generateText } from "ai";

const event: AlertEvent = {
  symbol: "XAUUSD", event_type: "READY", stage: "SIGNAL", direction: "SELL", confidence: 82,
  reason: "**Resistance rejection**; - - confirmation", occurred_at: "2026-10-07T16:31:00Z",
  entry: 100, stop_loss: 110, take_profit: 80,
  timeframe_context: { h4: "VOLATILITY_EXPANSION", h1: "PULLBACK", m15: "Resistance", m5: "Confirmation", decision: "READY" },
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Telegram presentation", () => {
  it("escapes untrusted HTML and converts bold/code/nested bullets", () => {
    const html = markdownToTelegramHtml("# Briefing\n- - **Status**: `READY` <script>x</script> &\n--\n- ** Level **\nbacktick `leak\nA -- B");
    expect(html).toContain("<b>Briefing</b>");
    expect(html).toContain("• <b>Status</b>: <code>READY</code> &lt;script&gt;x&lt;/script&gt; &amp;");
    expect(html).not.toMatch(/\*\*|`|--|- -/);
    expect(html).not.toContain("<script>");
  });

  it("strips fenced code artifacts without discarding facts", () => {
    const html = markdownToTelegramHtml("```json\n{\"status\": \"NO_DATA\"}\n```\n- - **Belum tersedia**");
    expect(html).not.toMatch(/```|json\n|\*\*/);
    expect(html).toContain("NO_DATA");
    expect(html).toContain("• <b>Belum tersedia</b>");
  });

  it("limits long messages with balanced tags and intact entities", () => {
    const html = limitTelegramHtml(`<b><code>${"😀&amp;".repeat(2000)}</code></b>`);
    expect(html.length).toBeLessThanOrEqual(4000);
    expect(html).toMatch(/…<\/code><\/b>$/);
    expect(html).not.toMatch(/&(a|am|amp)\u2026/);
    expect(markdownToTelegramHtml(`**${"x".repeat(6000)}**`)).toMatch(/<\/b>$/);
  });

  it("creates plain fallback without markup while preserving escaped literal text", () => {
    expect(telegramHtmlToPlainText("<b>Title</b>\n<code>READY</code> &amp; &lt;value&gt;")).toBe("Title\nREADY & <value>");
  });

  it("translates known enums without deleting the original fact or guessing unknown codes", () => {
    expect(readableEngineText("STAND_ASIDE / VOLATILITY_EXPANSION / UNKNOWN_123")).toBe("Menunggu di luar pasar / Stand Aside (STAND_ASIDE) / Volatilitas melebar (VOLATILITY_EXPANSION) / UNKNOWN_123");
  });

  it("formats alerts, AI explanation and timeframe rows without changing plan data", () => {
    const html = composeAlert(event, "**Takeaway**\n- - Menunggu `konfirmasi` <unsafe>");
    expect(html).toContain("<b>H4:</b>\nVolatilitas melebar (VOLATILITY_EXPANSION)");
    expect(html).toContain("<b>Risk/Reward:</b>\n1:2.00");
    expect(html).toContain("<b>Direction:</b>\n🔴 SELL");
    expect(html).toContain("• Menunggu <code>konfirmasi</code> &lt;unsafe&gt;");
    expect(html).not.toMatch(/\*\*|`|- -/);
    for (const type of ["BLOCKED", "EXIT", "ENGINE_OFFLINE", "EXECUTION"]) {
      const result = composeAlert({ ...event, event_type: type, reason: "**Reason** <raw> SL -1R" }, "- - **Review**");
      expect(result).not.toMatch(/\*\*|`|<raw>|- -/);
      expect(result.length).toBeLessThanOrEqual(4000);
    }
  });

  it("formats Q&A and keeps single-symbol questions scoped", async () => {
    const answer = await answerQuestion("Xau saat ini bagaimana?");
    expect(answer).toContain("<b>Ringkasan</b>");
    expect(answer).toContain("• <code>STAND_ASIDE</code>");
    expect(buildLiveContext).toHaveBeenCalledWith("XAUUSD");
    expect(buildLiveContext).not.toHaveBeenCalledWith("BTCUSD");
  });

  it("loads separately labelled sources for a two-symbol briefing", async () => {
    await answerQuestion("Briefing XAUUSD dan BTCUSD");
    expect(buildLiveContext).toHaveBeenCalledWith("XAUUSD");
    expect(buildLiveContext).toHaveBeenCalledWith("BTCUSD");
    expect(vi.mocked(generateText).mock.calls[0]?.[0].system).toContain("sumber dan timestamp terpisah");
    expect(vi.mocked(generateText).mock.calls[0]?.[0].system).toContain("Executive Briefing");
  });

  it("falls back without parse_mode only when Telegram rejects HTML", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key"); vi.stubEnv("TELEGRAM_API_KEY", "test-connection");
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetcher);
    expect((await sendTelegramMessage("test-chat", "<b>Title</b>\n• Clean")).status).toBe("SENT");
    const call = fetcher.mock.calls.at(1);
    if (!call?.[1]) throw new Error("Expected plain-text retry");
    const second = JSON.parse(call[1].body);
    expect(second.parse_mode).toBeUndefined();
    expect(second.text).toBe("Title\n• Clean");
  });

  it("handles ok:false in HTTP 200 and does not retry unrelated failures", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key"); vi.stubEnv("TELEGRAM_API_KEY", "test-connection");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden" })));
    vi.stubGlobal("fetch", fetcher);
    expect((await sendTelegramMessage("test-chat", "Clean")).status).toBe("FAILED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});