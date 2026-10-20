import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertOperator(supabase: { rpc: (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown }> }, userId: string) {
  const { data } = await supabase.rpc("is_engine_operator", { _user_id: userId });
  if (!data) throw new Error("Forbidden: operator only");
}

/** UPDATE DATA & REPORT: rebuilds the workbook from all stored history and returns it (no Telegram). */
export const generateLabReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertOperator(context.supabase as never, context.userId);
    const { runLabReport } = await import("./labReport.server");
    return runLabReport({ trigger: "MANUAL", telegram: false, returnFile: true });
  });

export const lastLabReportRun = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("lab_report_runs").select("slot_key,trigger,status,finished_at,unique_trades,net_pnl,telegram_status,note").order("started_at", { ascending: false }).limit(5);
    return data ?? [];
  });
