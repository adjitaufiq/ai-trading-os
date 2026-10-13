import { createFileRoute } from "@tanstack/react-router";
import { verifyRequest } from "@/core/execution/control/contract";
import { RelayPush } from "@/lib/engineStatus/relay";
import { syncRelayHealth } from "@/lib/engineStatus/relay.server";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// VPS status agent heartbeat. HMAC-signed with server-only ENGINE_STATUS_AGENT_SECRET; strict allowlist schema
// rejects any sensitive/extra field. Stores only the sanitized snapshot. No order or config path.
export const Route = createFileRoute("/api/public/agent/engine-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.text();
        if (body.length > 8192) return json({ error: "payload too large" }, 413);
        const ok = await verifyRequest(process.env["ENGINE_STATUS_AGENT_SECRET"], {
          ts: request.headers.get("x-agent-timestamp"), sig: request.headers.get("x-agent-signature"),
          method: "POST", path: new URL(request.url).pathname, body, now: Date.now(),
        });
        if (!ok) return json({ error: "unauthorized" }, 401);
        let p;
        try { p = RelayPush.parse(JSON.parse(body)); } catch { return json({ error: "invalid payload" }, 400); }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.from("engine_status_relay").upsert({ agent_id: p.agent_id, received_at: new Date().toISOString(), snapshot: p.snapshot as never });
        if (error) return json({ error: "store failed" }, 500);
        const health = await syncRelayHealth(Date.now()); // BACK ONLINE fires on first healthy heartbeat
        return json({ ok: true, status: health.status });
      },
    },
  },
});
