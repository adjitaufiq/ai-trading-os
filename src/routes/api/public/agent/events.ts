import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { readSignedAgentRequest, json } from "@/lib/control/agentAuth.server";

const Events = z.object({
  agent_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  events: z.array(z.object({
    type: z.string().min(1).max(32).regex(/^[A-Z_]+$/),
    at: z.number(), signal_id: z.string().max(120).nullable(), symbol: z.string().max(20).nullable(),
    detail: z.string().max(500).optional(),
  })).max(100),
});

// VPS agent PUSH: execution events → append-only execution_audit_log (source=agent). Observability only.
export const Route = createFileRoute("/api/public/agent/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readSignedAgentRequest(request);
        if (body === null) return json({ error: "unauthorized" }, 401);
        let p;
        try { p = Events.parse(JSON.parse(body)); } catch { return json({ error: "invalid payload" }, 400); }
        if (!p.events.length) return json({ ok: true, stored: 0 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.from("execution_audit_log").insert(p.events.map((e) => ({
          event_type: `EXECUTION_${e.type}`, new_value: { signal_id: e.signal_id, symbol: e.symbol, detail: e.detail ?? null },
          source: `agent:${p.agent_id}`, metadata: { at: new Date(e.at).toISOString() },
        })));
        if (error) return json({ error: "store failed" }, 500);
        return json({ ok: true, stored: p.events.length });
      },
    },
  },
});
