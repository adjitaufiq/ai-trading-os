import { publicStatus, healthTransition, RelaySnapshot, RELAY_SCHEMA, type PublicEngineStatus } from "./relay";
import { recordEngineHealth } from "@/lib/events/events.server";

/** Same status-only proxy (VPS 8782 tunnel) the dashboard reads. Public, sanitized, no secret. */
const STATUS_PROXY = ((import.meta.env["VITE_ENGINE_STATUS_URL"] as string | undefined) ?? "").replace(/\/+$/, "");
const PROXY_AGENT_ID = "status-proxy-8782";

async function fetchProxyOnce(): Promise<RelaySnapshot | null> {
  const r = await fetch(`${STATUS_PROXY}/v1/public/engine-status`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!r.ok) return null;
  const j = (await r.json()) as { schema?: unknown; status?: unknown; snapshot?: unknown };
  if (j?.schema !== RELAY_SCHEMA || j.status !== "ONLINE") return null;
  const p = RelaySnapshot.safeParse(j.snapshot); // strict allowlist: any extra field ⇒ rejected
  return p.success ? p.data : null;
}

/** Pull the status proxy and store it as a relay heartbeat. Failure stores nothing, so OFFLINE only follows
 *  after HEARTBEAT_STALE_MS without a healthy pull (debounce). Two attempts absorb a transient timeout. */
export async function pullStatusProxy(): Promise<boolean> {
  if (!STATUS_PROXY.startsWith("https://")) return false;
  for (let i = 0; i < 2; i++) {
    try {
      const s = await fetchProxyOnce();
      if (s) {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.from("engine_status_relay").upsert({ agent_id: PROXY_AGENT_ID, received_at: new Date().toISOString(), snapshot: s as never });
        return !error;
      }
    } catch { /* retry */ }
    if (i === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

export async function readRelayStatus(now: number): Promise<PublicEngineStatus> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("engine_status_relay").select("received_at, snapshot").order("received_at", { ascending: false }).limit(1);
  return publicStatus(data?.[0] ?? null, now);
}

/** Telegram ONLINE/OFFLINE from relay heartbeat (status proxy pull or agent push; stale threshold = debounce). Never throws. */
export async function syncRelayHealth(now: number): Promise<{ changed: boolean; status: string }> {
  try {
    await pullStatusProxy();
    const st = await readRelayStatus(Math.max(now, Date.now()));
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("engine_events").select("event_type").in("event_type", ["ENGINE_OFFLINE", "ENGINE_ONLINE"]).order("occurred_at", { ascending: false }).limit(1);
    const last = (data?.[0]?.event_type ?? null) as "ENGINE_ONLINE" | "ENGINE_OFFLINE" | null;
    const t = healthTransition(last, st);
    if (!t) return { changed: false, status: st.status };
    const age = st.heartbeat_age_ms === null ? "-" : `${Math.round(st.heartbeat_age_ms / 1000)}s`;
    await recordEngineHealth(t === "ENGINE_ONLINE", t === "ENGINE_ONLINE"
      ? `Status engine: heartbeat sehat (umur ${age})`
      : `Status engine: heartbeat basi/engine tidak terjangkau (umur ${age})`);
    return { changed: true, status: st.status };
  } catch (e) { console.error("[status-relay] health sync failed", (e as Error).message); return { changed: false, status: "ERROR" }; }
}
