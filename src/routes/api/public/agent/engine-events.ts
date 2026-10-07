import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { readSignedAgentRequest, json } from "@/lib/control/agentAuth.server";
import { ingestEventRows, pipelineToRow, type PipelineEv } from "@/lib/events/events.server";

const Ev = z.object({
  type: z.enum(["READY", "BLOCKED", "EXECUTION", "EXIT"]), stage: z.string().max(40), symbol: z.string().min(1).max(20),
  signalId: z.string().max(120).nullable(), direction: z.enum(["BUY", "SELL"]).nullable(), at: z.number(),
  reason: z.string().max(500), entry: z.number().nullable(), stopLoss: z.number().nullable(), takeProfit: z.number().nullable(),
  confidence: z.number().nullable(), timeframe_context: z.record(z.string(), z.unknown()), snapshot_ref: z.number().nullable(),
}).passthrough();
const Body = z.object({ agent_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/), events: z.array(Ev).max(200) });

// VPS PUSH of engine pipeline events (from its on-disk outbox) → append-only engine_events + Telegram. HMAC-signed only.
export const Route = createFileRoute("/api/public/agent/engine-events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readSignedAgentRequest(request);
        if (body === null) return json({ error: "unauthorized" }, 401);
        let p;
        try { p = Body.parse(JSON.parse(body)); } catch { return json({ error: "invalid payload" }, 400); }
        const rows = p.events.map((e) => ({ ...pipelineToRow(e as PipelineEv), source: `agent:${p.agent_id}` }));
        const res = await ingestEventRows(rows);
        if ("error" in res) return json({ error: "store failed" }, 500);
        return json({ ok: true, received: rows.length, ...res });
      },
    },
  },
});
