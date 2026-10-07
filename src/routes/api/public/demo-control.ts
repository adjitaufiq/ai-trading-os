import { createFileRoute } from "@tanstack/react-router";

// Read-only demo-lab kill-switch state for the VPS engine host (polled every 15 s).
// Returns only a boolean; no write here. Any failure reports stopped=true (fail-closed).
export const Route = createFileRoute("/api/public/demo-control")({
  server: {
    handlers: {
      GET: async () => {
        let stopped = true;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data, error } = await supabaseAdmin.from("demo_execution_control").select("stopped").eq("id", 1).maybeSingle();
          stopped = error || !data ? true : data.stopped !== false;
        } catch { stopped = true; }
        return new Response(JSON.stringify({ stopped }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      },
    },
  },
});
