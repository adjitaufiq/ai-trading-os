// Typed read-only client for the persistent engine host. Strict envelope validation; any failure is an explicit
// error result (never substituted data). The dashboard decides attach vs browser-session from these results only.
import type { RadarHealth, RadarSnapshot } from "../radar/types";
import type { VirtualAccountView } from "../paper/LivePaperLoop";
import { ENGINE_HOST_SCHEMA, type EngineEnvelope, type EngineHostHealth, type EngineSymbolBundle } from "./types";
import { EXECUTION_STATUS_SCHEMA, type ExecutionStatusView } from "./executionStatus";
import { parseSnrSnapshot, type SnrSnapshot } from "@/lib/snrOverlay";

export type EngineResult<T> = { readonly ok: true; readonly envelope: EngineEnvelope<T> } | { readonly ok: false; readonly error: string };

export interface EngineHostClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const STATES = new Set(["STARTING", "BOOTSTRAP", "SYNCING", "ONLINE", "DEGRADED", "OFFLINE"]);

function isEnvelope(x: unknown): x is EngineEnvelope<unknown> {
  const e = x as Record<string, unknown> | null;
  return !!e && e["schema"] === ENGINE_HOST_SCHEMA && e["source"] === "ENGINE_HOST" && typeof e["generated_at"] === "number" && "data" in e;
}

const EXEC_ENUMS: Record<string, readonly unknown[]> = {
  engine: ["ONLINE", "DEGRADED", "OFFLINE"], mode: ["MONITOR_ONLY", "DEMO_EXECUTION"],
  execution: ["READY", "WAITING_SIGNAL", "ACTIVE", "BLOCKED", "UNKNOWN"], account: ["PASS", "FAIL", "UNKNOWN"],
  mt5: ["CONNECTED", "DISCONNECTED", "UNKNOWN"], shadow: ["CLEAR", "BLOCKING"], risk: ["PASS", "BLOCKED", "UNKNOWN"],
  reconciliation: ["CLEAN", "MISMATCH", "UNKNOWN"], signal: ["READY", "WAITING", "UNKNOWN"],
};
export function isExecutionStatus(x: unknown): x is ExecutionStatusView {
  const e = x as Record<string, unknown> | null;
  if (!e || e["schema"] !== EXECUTION_STATUS_SCHEMA || typeof e["kill_switch"] !== "boolean" || typeof e["stale"] !== "boolean" || typeof e["checked_at"] !== "number" || !Array.isArray(e["blockers"])) return false;
  return Object.entries(EXEC_ENUMS).every(([k, v]) => v.includes(e[k]));
}

export function isEngineHostHealth(x: unknown): x is EngineHostHealth {
  const h = x as Record<string, unknown> | null;
  if (!h || !Array.isArray(h["symbols"]) || typeof h["execution_enabled"] !== "boolean") return false;
  const mode = h["operating_mode"];
  // MONITOR_ONLY must report execution disabled; DEMO may report either. Any other mode is rejected.
  if (mode === "MONITOR_ONLY") { if (h["execution_enabled"] !== false) return false; }
  else if (mode !== "DEMO") return false;
  return (h["symbols"] as unknown[]).every((s) => {
    const o = s as Record<string, unknown> | null;
    return !!o && typeof o["symbol"] === "string" && STATES.has(o["state"] as string);
  });
}

export function isBundle(x: unknown): x is EngineSymbolBundle {
  const b = x as Record<string, unknown> | null;
  return !!b && b["source"] === "ENGINE_HOST" && typeof b["symbol"] === "string" && typeof b["timestamp"] === "number" && "slice" in b && "radar" in b;
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
  executionStatus() { return this.get<ExecutionStatusView>("/v1/engine/execution-status", isExecutionStatus); }
  /** Dedicated visual SNR contract; accept raw response or the standard host envelope, never another source. */
  async snr(symbol: string): Promise<{ ok: true; data: SnrSnapshot } | { ok: false; error: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 5_000);
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`${this.base}/v1/analysis/snr/${encodeURIComponent(symbol)}`, { method: "GET", signal: ctl.signal });
      if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
      const body: unknown = await res.json();
      const data = parseSnrSnapshot(isEnvelope(body) ? body.data : body, symbol);
      return data ? { ok: true, data } : { ok: false, error: "INVALID_SNR_RESPONSE" };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "UNREACHABLE" };
    } finally { clearTimeout(timer); }
  }
  radar(symbol: string) {
    return this.get<{ symbol: string; snapshot: Readonly<RadarSnapshot> | null; health: Readonly<RadarHealth> | null }>(
      `/v1/engine/${encodeURIComponent(symbol)}/radar`, (d) => (d as { symbol?: unknown })?.symbol === symbol);
  }
  /** All hosted symbols' bundles in one GET (refresh recovery). */
  snapshots() {
    return this.get<{ bundles: readonly EngineSymbolBundle[] }>("/v1/engine/snapshot", (d) => Array.isArray((d as { bundles?: unknown })?.bundles) && ((d as { bundles: unknown[] }).bundles).every(isBundle));
  }
  get eventsUrl(): string { return `${this.base}/v1/engine/events`; }
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
