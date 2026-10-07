import { createFileRoute } from "@tanstack/react-router";
import { readSignedAgentRequest, json } from "@/lib/control/agentAuth.server";
import { CONTROL_CONTRACT_VERSION, deriveControl } from "@/core/execution/control/contract";

// VPS agent PULL: execution_config (signed). Read-only; returns config + fail-closed derived control.
export const Route = createFileRoute("/api/public/agent/config")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if ((await readSignedAgentRequest(request)) === null) return json({ error: "unauthorized" }, 401);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const [{ data: cfg }, { data: legacy }] = await Promise.all([
          supabaseAdmin.from("execution_config").select("execution_mode,demo_enabled,kill_switch,risk_percent,max_open_positions,max_daily_loss_percent,max_daily_trades,allowed_symbols,updated_at").eq("id", 1).maybeSingle(),
          supabaseAdmin.from("demo_execution_control").select("stopped").eq("id", 1).maybeSingle(),
        ]);
        const legacyStopped = legacy ? legacy.stopped !== false : true;
        return json({ version: CONTROL_CONTRACT_VERSION, config: cfg ?? null, control: deriveControl(cfg ?? null, legacyStopped) });
      },
    },
  },
});
