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
      const attempt = async (url: string) => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 10_000);
        try {
          const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
          if (!r.ok) return { err: `HTTP_${r.status}` } as const;
          return { data: (await r.json()) as PublicEngineStatus } as const;
        } catch (e) {
          return { err: (e as Error).name === "AbortError" ? "TIMEOUT" : "NETWORK" } as const;
        } finally {
          clearTimeout(t);
        }
      };
      let res = await attempt(STATUS_URL);
      if ("err" in res && FALLBACK_URL) res = await attempt(FALLBACK_URL);
      if (!alive) return;
      if ("err" in res) { setError(res.err); setStatus(null); return; }
      setStatus(res.data); setError(null);
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
