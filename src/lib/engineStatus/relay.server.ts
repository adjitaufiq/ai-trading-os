import { publicStatus, healthTransition, type PublicEngineStatus } from "./relay";
import { recordEngineHealth } from "@/lib/events/events.server";

export async function readRelayStatus(now: number): Promise<PublicEngineStatus> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("engine_status_relay").select("received_at, snapshot").order("received_at", { ascending: false }).limit(1);
  return publicStatus(data?.[0] ?? null, now);
}

/** Telegram ONLINE/OFFLINE from relay heartbeat only (stale threshold = debounce). Never throws. */
export async function syncRelayHealth(now: number): Promise<{ changed: boolean; status: string }> {
  try {
    const st = await readRelayStatus(now);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("engine_events").select("event_type").in("event_type", ["ENGINE_OFFLINE", "ENGINE_ONLINE"]).order("occurred_at", { ascending: false }).limit(1);
    const last = (data?.[0]?.event_type ?? null) as "ENGINE_ONLINE" | "ENGINE_OFFLINE" | null;
    const t = healthTransition(last, st);
    if (!t) return { changed: false, status: st.status };
    const age = st.heartbeat_age_ms === null ? "-" : `${Math.round(st.heartbeat_age_ms / 1000)}s`;
    await recordEngineHealth(t === "ENGINE_ONLINE", t === "ENGINE_ONLINE"
      ? `Status relay: heartbeat sehat (umur ${age})`
      : `Status relay: heartbeat basi/engine tidak terjangkau (umur ${age})`);
    return { changed: true, status: st.status };
  } catch (e) { console.error("[status-relay] health sync failed", (e as Error).message); return { changed: false, status: "ERROR" }; }
}
