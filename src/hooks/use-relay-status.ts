import { useEffect, useState } from "react";
import type { PublicEngineStatus } from "@/lib/engineStatus/relay";

/** Polls the sanitized same-origin status relay (no Engine Host URL, no secret in the browser). */
export function useRelayStatus(intervalMs = 15_000): { status: PublicEngineStatus | null; error: string | null } {
  const [status, setStatus] = useState<PublicEngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 10_000);
        const r = await fetch("/api/public/engine-status", { signal: ctl.signal, cache: "no-store" });
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
  if (err) return `STATUS RELAY UNREACHABLE (${err})`;
  if (!s) return "STATUS RELAY: memuat…";
  if (s.status === "NO_DATA") return "STATUS RELAY: belum ada heartbeat dari VPS";
  const age = s.heartbeat_age_ms === null ? "-" : `${Math.round(s.heartbeat_age_ms / 1000)}s`;
  if (s.status === "OFFLINE" || !s.snapshot) return `STATUS RELAY: ENGINE OFFLINE · heartbeat ${age} lalu`;
  const x = s.snapshot;
  return `STATUS RELAY: ENGINE ${x.engine} · ${x.phase ?? x.stage ?? "-"} · signal ${x.signal} · MT5 ${x.mt5} · Shadow ${x.shadow} · data ${s.data} · heartbeat ${age}${x.blockers.length ? ` · blocker ${x.blockers.join(", ")}` : ""}`;
}
