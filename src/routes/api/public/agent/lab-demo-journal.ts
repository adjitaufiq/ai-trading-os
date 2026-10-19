import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { readSignedAgentRequest, json } from "@/lib/control/agentAuth.server";
import { eventKey, tradeFingerprint, upsertDecision } from "@/core/lab/demo/demoJournal";

const num = z.number().finite();
const Trade = z.object({
  signalId: z.string().min(1).max(64), strategy: z.string().min(1).max(40), symbol: z.string().min(1).max(20),
  side: z.enum(["BUY", "SELL"]), barTime: num,
  status: z.enum(["PENDING", "OPEN", "CLOSING", "CLOSED", "REJECTED", "UNKNOWN", "NOT_FILLED"]),
  ticket: num.nullable(), openedAt: num, closedAt: num.nullable(), pnlUsd: num.nullable(),
}).passthrough();
const Event = z.object({ line: z.string().min(2).max(8000) });
const Body = z.object({
  agent_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  snapshot_at: num,
  runner: z.object({ version: z.string().max(80), armed: z.boolean(), phase: z.string().max(40), reconciliationClean: z.boolean(), blockReason: z.string().max(200).nullable() }),
  trades: z.array(Trade).max(500),
  events: z.array(Event).max(500).default([]),
});

// VPS Lab runner journal PUSH (HMAC). Observability only: stores copies, never reaches broker or execution.
export const Route = createFileRoute("/api/public/agent/lab-demo-journal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await readSignedAgentRequest(request);
        if (raw === null) return json({ error: "unauthorized" }, 401);
        let p: z.infer<typeof Body>;
        try { p = Body.parse(JSON.parse(raw)); } catch { return json({ error: "invalid payload" }, 400); }
        if (Math.abs(Date.now() - p.snapshot_at) > 24 * 3600_000) return json({ error: "snapshot timestamp out of range" }, 400);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const ids = p.trades.map((t) => t.signalId);
        const { data: existing, error: e1 } = ids.length
          ? await supabaseAdmin.from("lab_demo_trades").select("signal_id,fingerprint,snapshot_at_ms").eq("agent_id", p.agent_id).in("signal_id", ids)
          : { data: [], error: null };
        if (e1) return json({ error: "read failed" }, 500);
        const byId = new Map((existing ?? []).map((r) => [r.signal_id, r]));
        const counts = { INSERT: 0, UPDATE: 0, SKIP_DUPLICATE: 0, SKIP_STALE: 0 };
        const rows = [];
        for (const t of p.trades) {
          const fp = tradeFingerprint(t);
          const prev = byId.get(t.signalId);
          const d = upsertDecision(prev ? { fingerprint: prev.fingerprint, snapshot_at_ms: Number(prev.snapshot_at_ms) } : null, { fingerprint: fp, snapshot_at_ms: p.snapshot_at });
          counts[d]++;
          if (d === "INSERT" || d === "UPDATE") rows.push({
            agent_id: p.agent_id, signal_id: t.signalId, strategy: t.strategy, symbol: t.symbol, side: t.side, status: t.status,
            ticket: t.ticket, opened_at_ms: Math.round(t.openedAt), closed_at_ms: t.closedAt == null ? null : Math.round(t.closedAt),
            pnl_usd: t.pnlUsd, fingerprint: fp, snapshot_at_ms: Math.round(p.snapshot_at), payload: t, updated_at: new Date().toISOString(),
          });
        }
        if (rows.length) {
          const { error } = await supabaseAdmin.from("lab_demo_trades").upsert(rows as never, { onConflict: "agent_id,signal_id" });
          if (error) return json({ error: "store failed" }, 500);
        }
        let eventsStored = 0;
        if (p.events.length) {
          const evRows = p.events.flatMap((e) => {
            let o: Record<string, unknown>; try { o = JSON.parse(e.line); } catch { return []; }
            const at = typeof o["at_local"] === "string" ? Date.parse(o["at_local"] as string) : NaN;
            const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string).slice(0, 64) : null);
            return [{ agent_id: p.agent_id, event_key: eventKey(e.line), event_type: (s("type") ?? "UNKNOWN").slice(0, 40), signal_id: s("signalId"), symbol: s("symbol"), strategy: s("strategy"), at_ms: Number.isFinite(at) ? at : null, payload: o }];
          });
          const { error, count } = await supabaseAdmin.from("lab_demo_events").upsert(evRows as never, { onConflict: "agent_id,event_key", ignoreDuplicates: true, count: "exact" });
          if (error) return json({ error: "event store failed" }, 500);
          eventsStored = count ?? evRows.length;
        }
        const { data: prevStatus } = await supabaseAdmin.from("lab_demo_sync_status").select("snapshot_at_ms").eq("agent_id", p.agent_id).maybeSingle();
        if (prevStatus && Number(prevStatus.snapshot_at_ms) > p.snapshot_at) return json({ ok: true, trades: counts, events_stored: eventsStored, status: "SKIP_STALE" });
        const { error: e3 } = await supabaseAdmin.from("lab_demo_sync_status").upsert({
          agent_id: p.agent_id, runner_version: p.runner.version, armed: p.runner.armed, phase: p.runner.phase,
          reconciliation_clean: p.runner.reconciliationClean, block_reason: p.runner.blockReason,
          snapshot_at_ms: Math.round(p.snapshot_at), trades_count: p.trades.length, last_received_at: new Date().toISOString(),
        });
        if (e3) return json({ error: "status store failed" }, 500);
        return json({ ok: true, trades: counts, events_stored: eventsStored });
      },
    },
  },
});
