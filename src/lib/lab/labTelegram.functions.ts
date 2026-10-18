// Strategy Lab hourly report → operator Telegram. Text is a copy of the PAPER report; it never trades or changes config.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const sendLabReportTelegram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ text: z.string().min(1).max(12000) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isOp } = await supabase.rpc("is_engine_operator", { _user_id: userId });
    if (!isOp) throw new Error("Forbidden");
    const { sendTelegramMessage, operatorChatId } = await import("@/lib/assistant/telegram.server");
    const { escapeTelegramHtml } = await import("@/lib/assistant/telegramFormat");
    const res = await sendTelegramMessage(operatorChatId(), escapeTelegramHtml(data.text));
    return { status: res.status, note: res.note };
  });
