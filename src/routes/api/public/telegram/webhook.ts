import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { answerQuestion, isOperatorChat, sendTelegramMessage, telegramWebhookSeed } from "@/lib/assistant/telegram.server";

const derive = (k: string) => createHash("sha256").update(`telegram-webhook:${k}`).digest("base64url");
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// Telegram → mobile AI Assistant (explain-only). Only the configured operator chat gets answers; no command can
// trade, change risk or alter config. Unknown chats only learn their own chat id.
export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Always 200 to Telegram so it never retries forever; unverified requests are dropped, never processed.
        const tk = telegramWebhookSeed();
        if (!tk) { console.error("[telegram] TELEGRAM_BOT_TOKEN missing at runtime; update dropped"); return Response.json({ ok: true, ignored: "not_configured" }); }
        if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", derive(tk))) return Response.json({ ok: true, ignored: "unauthorized" });
        const update = await request.json().catch(() => null) as { message?: { chat?: { id?: number }; text?: string } } | null;
        const chatId = update?.message?.chat?.id, text = update?.message?.text?.trim();
        if (!chatId || !text) return Response.json({ ok: true });
        if (!isOperatorChat(chatId)) {
          console.log(`[telegram] message from unregistered chat ${chatId}`);
          await sendTelegramMessage(chatId, `Chat ini belum terdaftar sebagai operator. Chat ID: <code>${chatId}</code>`);
          return Response.json({ ok: true });
        }
        const { COCKPIT_KEYBOARD, matchButton, renderCockpit } = await import("@/lib/assistant/telegramCockpit.server");
        if (text === "/start" || text === "/help" || text === "/menu") {
          await sendTelegramMessage(chatId, "AI Trading Assistant (mobile). Pakai 6 tombol di bawah untuk data engine, atau tanya bebas, mis. <i>Kenapa BTC SELL?</i>. Bot ini hanya menjelaskan — tidak bisa order.", COCKPIT_KEYBOARD);
          return Response.json({ ok: true });
        }
        const action = matchButton(text);
        if (action) {
          let card: string;
          try { card = await renderCockpit(action, Date.now()); }
          catch (e) { console.error("[telegram] cockpit failed", e); card = "Data engine belum bisa dibaca. Coba lagi sebentar."; }
          try { await sendTelegramMessage(chatId, card, COCKPIT_KEYBOARD); } catch (e) { console.error("[telegram] send failed", e); }
          return Response.json({ ok: true });
        }
        // Never 500 back to Telegram (it retries forever and blocks the queue); log and reply with a safe fallback.
        let answer: string;
        try { answer = await answerQuestion(text); }
        catch (e) { console.error("[telegram] answerQuestion failed", e); answer = "AI sedang tidak tersedia. Data engine tetap jalan; coba lagi sebentar."; }
        // answerQuestion returns safe Telegram HTML; escaping it again exposes markup to the operator.
        try { await sendTelegramMessage(chatId, answer); }
        catch (e) { console.error("[telegram] send failed", e); }
        return Response.json({ ok: true });
      },
    },
  },
});
