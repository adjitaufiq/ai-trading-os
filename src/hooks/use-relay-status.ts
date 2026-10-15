import { useEffect, useState } from "react";
import type { PublicEngineStatus } from "@/lib/engineStatus/relay";

/** Status-only proxy (VPS, own Quick Tunnel) when configured; otherwise the same-origin relay. Both return the
 *  same sanitized PublicEngineStatus shape; no Engine Host URL and no secret in the browser. */
const STATUS_PROXY = (import.meta.env['VITE_ENGINE_STATUS_URL'] as string | undefined)?.replace(/\/+$/, "") || "";
export const STATUS_SOURCE = STATUS_PROXY ? "STATUS PROXY" : "STATUS RELAY";
const STATUS_URL = STATUS_PROXY ? `${STATUS_PROXY}/v1/public/engine-status` : "/api/public/engine-status";
// Same-origin relay fallback when the status proxy is unreachable (e.g. CORS from a different origin).
const FALLBACK_URL = STATUS_PROXY ? "/api/public/engine-status" : null;

export function useRelayStatus(intervalMs = 15_000): { status: PublicEngineStatus | null; error: string | null } {
  const [status, setStatus] = useState<PublicEngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 10_000);
        const r = await fetch(STATUS_URL, { signal: ctl.signal, cache: "no-store" });
        clearTimeout(t);
        if (!alive) return;
        if (!r.ok) { setError(`HTTP_${r.status}`); setStatus(null); return; }
        setStatus((await r.json()) as PublicEngineStatus); setError(null);
      } catch (e) { if (alive) { setError((e as Error).name === "AbortError" ? "TIMEOUT" : "NETWORK"); setStatus(null); } }
    };
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);
  return { status, error };
}

export function relayLine(s: PublicEngineStatus | null, err: string | null): string {
  if (err) return `${STATUS_SOURCE} UNREACHABLE (${err})`;
  if (!s) return `${STATUS_SOURCE}: memuat…`;
  if (s.status === "NO_DATA") return `${STATUS_SOURCE}: belum ada heartbeat dari VPS`;
  const age = s.heartbeat_age_ms === null ? "-" : `${Math.round(s.heartbeat_age_ms / 1000)}s`;
  if (s.status === "OFFLINE" || !s.snapshot) return `${STATUS_SOURCE}: ENGINE OFFLINE · heartbeat ${age} lalu`;
  const x = s.snapshot;
  return `${STATUS_SOURCE}: ENGINE ${x.engine} · ${x.phase ?? x.stage ?? "-"} · signal ${x.signal} · MT5 ${x.mt5} · Shadow ${x.shadow} · data ${s.data} · heartbeat ${age}${x.blockers.length ? ` · blocker ${x.blockers.join(", ")}` : ""}`;
}
