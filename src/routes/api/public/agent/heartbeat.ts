import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { readSignedAgentRequest, json } from "@/lib/control/agentAuth.server";
import { maskAccount } from "@/core/execution/control/contract";

const Heartbeat = z.object({
  agent_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  mt5_connected: z.boolean(),
  account_mode: z.string().max(16).nullable(),
  account_number_masked: z.string().max(32).nullable(),
  broker_server: z.string().max(80).nullable(),
  execution_mode: z.string().max(32),
  open_positions: z.number().int().min(0).max(1000).nullable(),
  current_version: z.string().max(40).nullable(),
  last_error: z.string().max(500).nullable(),
});

// VPS agent PUSH: heartbeat + MT5 status (signed). Writes observability only.
export const Route = createFileRoute("/api/public/agent/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readSignedAgentRequest(request);
        if (body === null) return json({ error: "unauthorized" }, 401);
        let parsed;
        try { parsed = Heartbeat.parse(JSON.parse(body)); } catch { return json({ error: "invalid payload" }, 400); }
        const now = new Date().toISOString();
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.from("execution_agent_status").upsert({
          ...parsed, account_number_masked: maskAccount(parsed.account_number_masked),
          agent_online: true, last_heartbeat: now, updated_at: now,
        }, { onConflict: "agent_id" });
        if (error) return json({ error: "store failed" }, 500);
        return json({ ok: true, at: now });
      },
    },
  },
});
