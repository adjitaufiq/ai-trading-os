import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";
import { answerQuestion, sendTelegramMessage } from "@/lib/assistant/telegram.server";

const derive = (k: string) => createHash("sha256").update(`telegram-webhook:${k}`).digest("base64url");
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// Telegram → mobile AI Assistant (explain-only). Only the configured operator chat gets answers; no command can
// trade, change risk or alter config. Unknown chats only learn their own chat id.
export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const tk = process.env["TELEGRAM_API_KEY"];
        if (!tk) return new Response("not configured", { status: 500 });
        if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", derive(tk))) return new Response("Unauthorized", { status: 401 });
        const update = await request.json().catch(() => null) as { message?: { chat?: { id?: number }; text?: string } } | null;
        const chatId = update?.message?.chat?.id, text = update?.message?.text?.trim();
        if (!chatId || !text) return Response.json({ ok: true });
        const allowed = process.env["TELEGRAM_CHAT_ID"];
        if (!allowed || String(chatId) !== allowed.trim()) {
          console.log(`[telegram] message from unregistered chat ${chatId}`);
          await sendTelegramMessage(chatId, `Chat ini belum terdaftar sebagai operator. Chat ID: <code>${chatId}</code>`);
          return Response.json({ ok: true });
        }
        if (text === "/start" || text === "/help") {
          await sendTelegramMessage(chatId, "AI Trading Assistant (mobile). Tanya apa saja, mis. <i>Kenapa BTC SELL?</i> atau <i>Briefing XAUUSD</i>. Bot ini hanya menjelaskan keputusan engine — tidak bisa order.");
          return Response.json({ ok: true });
        }
        const answer = await answerQuestion(text);
        await sendTelegramMessage(chatId, answer.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 4000));
        return Response.json({ ok: true });
      },
    },
  },
});
