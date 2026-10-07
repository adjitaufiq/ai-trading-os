import { createFileRoute } from "@tanstack/react-router";

// Read-only demo-lab kill-switch state for the VPS engine host (polled every 15 s; Phase 6A contract).
// Returns only a boolean. stopped = legacy switch OR execution_config not armed for demo (kill switch,
// demo disabled, mode != DEMO_STRESS_TEST). Any failure reports stopped=true (fail-closed).
export const Route = createFileRoute("/api/public/demo-control")({
  server: {
    handlers: {
      GET: async () => {
        let stopped = true;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { deriveControl } = await import("@/core/execution/control/contract");
          const [legacy, cfg] = await Promise.all([
            supabaseAdmin.from("demo_execution_control").select("stopped").eq("id", 1).maybeSingle(),
            supabaseAdmin.from("execution_config").select("execution_mode,demo_enabled,kill_switch,risk_percent,max_open_positions,max_daily_loss_percent,max_daily_trades,allowed_symbols,updated_at").eq("id", 1).maybeSingle(),
          ]);
          const legacyStopped = legacy.error || !legacy.data ? true : legacy.data.stopped !== false;
          stopped = cfg.error ? true : deriveControl(cfg.data ?? null, legacyStopped).halted;
        } catch { stopped = true; }
        return new Response(JSON.stringify({ stopped }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      },
    },
  },
});
