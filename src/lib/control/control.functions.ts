// Step 2 control plane — admin-only config actions. Runs as the signed-in user; the database function
// update_execution_config re-checks admin and the trigger writes execution_audit_log for every change.
// There is no broker call here: the cloud only stores configuration; the VPS agent pulls it.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ENABLE_DEMO") }),
  z.object({ action: z.literal("DISABLE_EXECUTION") }),
  z.object({ action: z.literal("KILL_SWITCH") }),
  z.object({
    action: z.literal("UPDATE_RISK"),
    risk_percent: z.number().gt(0).max(2),
    max_open_positions: z.number().int().min(1).max(5),
    max_daily_loss_percent: z.number().gt(0).max(10),
    max_daily_trades: z.number().int().min(1).max(50),
    allowed_symbols: z.array(z.string().regex(/^[A-Za-z0-9._]{2,20}$/)).min(1).max(10),
  }),
]);

export const executionControlAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => Action.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const patch =
      data.action === "ENABLE_DEMO" ? { execution_mode: "DEMO_STRESS_TEST", demo_enabled: true, kill_switch: false }
      : data.action === "DISABLE_EXECUTION" ? { execution_mode: "PAPER_ONLY", demo_enabled: false }
      : data.action === "KILL_SWITCH" ? { kill_switch: true }
      : { risk_percent: data.risk_percent, max_open_positions: data.max_open_positions, max_daily_loss_percent: data.max_daily_loss_percent,
          max_daily_trades: data.max_daily_trades, allowed_symbols: data.allowed_symbols.map((s) => s.toUpperCase()) };
    const { error } = await supabase.rpc("update_execution_config", { _patch: patch });
    if (error) throw new Error(error.message);

    // Keep the Phase 6A demo-lab switch in lockstep (its own trigger logs to demo_execution_control_log).
    if (data.action !== "UPDATE_RISK") {
      const stopped = data.action !== "ENABLE_DEMO";
      await supabase.from("demo_execution_control").update({
        stopped, reason: `control plane: ${data.action}`, updated_by: userId, updated_at: new Date().toISOString(),
      }).eq("id", 1);
    }
    return { ok: true as const };
  });
