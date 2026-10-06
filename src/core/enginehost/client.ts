// Typed read-only client for the persistent engine host. Strict envelope validation; any failure is an explicit
// error result (never substituted data). The dashboard decides attach vs browser-session from these results only.
import type { RadarHealth, RadarSnapshot } from "../radar/types";
import type { VirtualAccountView } from "../paper/LivePaperLoop";
import { ENGINE_HOST_SCHEMA, type EngineEnvelope, type EngineHostHealth } from "./types";

export type EngineResult<T> = { readonly ok: true; readonly envelope: EngineEnvelope<T> } | { readonly ok: false; readonly error: string };

export interface EngineHostClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const STATES = new Set(["STARTING", "SYNCING", "ONLINE", "DEGRADED", "OFFLINE"]);

function isEnvelope(x: unknown): x is EngineEnvelope<unknown> {
  const e = x as Record<string, unknown> | null;
  return !!e && e["schema"] === ENGINE_HOST_SCHEMA && e["source"] === "ENGINE_HOST" && typeof e["generated_at"] === "number" && "data" in e;
}

export function isEngineHostHealth(x: unknown): x is EngineHostHealth {
  const h = x as Record<string, unknown> | null;
  if (!h || h["operating_mode"] !== "MONITOR_ONLY" || h["execution_enabled"] !== false || !Array.isArray(h["symbols"])) return false;
  return (h["symbols"] as unknown[]).every((s) => {
    const o = s as Record<string, unknown> | null;
    return !!o && typeof o["symbol"] === "string" && STATES.has(o["state"] as string);
  });
}

export class EngineHostClient {
  private readonly base: string;
  constructor(private readonly o: EngineHostClientOptions) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("engine host URL must be http(s)");
    if (u.username || u.password) throw new Error("engine host URL must not carry credentials");
    this.base = o.baseUrl.replace(/\/+$/, "");
  }

  private async get<T>(path: string, check: (d: unknown) => boolean): Promise<EngineResult<T>> {
    const f = this.o.fetchImpl ?? fetch;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 5_000);
    try {
      const res = await f(`${this.base}${path}`, { method: "GET", signal: ctl.signal });
      if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
      const body: unknown = await res.json();
      if (!isEnvelope(body) || !check(body.data)) return { ok: false, error: "INVALID_ENVELOPE" };
      return { ok: true, envelope: body as EngineEnvelope<T> };
    } catch (e) {
      return { ok: false, error: (e as Error).name === "AbortError" ? "TIMEOUT" : `UNREACHABLE ${(e as Error).message}` };
    } finally { clearTimeout(t); }
  }

  health() { return this.get<EngineHostHealth>("/v1/engine/health", isEngineHostHealth); }
  radar(symbol: string) {
    return this.get<{ symbol: string; snapshot: Readonly<RadarSnapshot> | null; health: Readonly<RadarHealth> | null }>(
      `/v1/engine/${encodeURIComponent(symbol)}/radar`, (d) => (d as { symbol?: unknown })?.symbol === symbol);
  }
  account(symbol: string) {
    return this.get<{ symbol: string; account: Readonly<VirtualAccountView> | null }>(
      `/v1/engine/${encodeURIComponent(symbol)}/account`, (d) => (d as { symbol?: unknown })?.symbol === symbol);
  }
}

/** Engine host URL from env (VITE_ENGINE_HOST_URL); null when not configured (dashboard stays in browser session). */
export function engineHostUrlFromEnv(): string | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const v = env["VITE_ENGINE_HOST_URL"];
  return v && v.trim() ? v.trim() : null;
}
