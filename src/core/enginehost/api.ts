// Read-only HTTP routing for the engine host (transport-agnostic, pure). Static GET table only:
// there is no write route, no generic dispatch and no order/execution surface.
import { ENGINE_HOST_SCHEMA, type EngineEnvelope } from "./types";
import type { EngineHost } from "./EngineHost";
import { snrPayload } from "./snr";

export interface EngineHttpResponse { readonly status: number; readonly body: string; readonly headers: Readonly<Record<string, string>> }

export const ENGINE_CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
});

const json = (status: number, body: unknown): EngineHttpResponse =>
  ({ status, body: JSON.stringify(body), headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...ENGINE_CORS_HEADERS } });

export function envelope<T>(data: T, now: number): EngineEnvelope<T> {
  return { schema: ENGINE_HOST_SCHEMA, source: "ENGINE_HOST", generated_at: now, data };
}

type HostView = Pick<EngineHost, "health" | "reader" | "symbols"> & Partial<Pick<EngineHost, "bundle" | "bundleKey" | "demoStatus" | "pipelineEvents" | "readiness" | "buildInfo" | "monitoring" | "journalStatus" | "shadowStatus" | "executionStatus">>;

export function routeEngineRequest(host: HostView, method: string, rawPath: string, now: number): EngineHttpResponse {
  if (method === "OPTIONS") return { status: 204, body: "", headers: { ...ENGINE_CORS_HEADERS } };
  if (method !== "GET") return json(405, { error: "METHOD_NOT_ALLOWED", detail: "engine host is read-only" });
  const path = rawPath.split("?")[0]!.replace(/\/+$/, "");
  if (path === "/v1/engine/health") return json(200, envelope(host.health(), now));
  if (path === "/v1/engine/execution-status") {
    if (!host.executionStatus) return json(404, { error: "NOT_AVAILABLE" });
    return json(200, envelope(host.executionStatus(now), now));
  }
  if (path === "/v1/engine/version") return json(200, envelope(host.buildInfo?.() ?? host.health().build ?? null, now));
  if (path === "/v1/engine/account") return json(200, envelope({ accounts: host.symbols.map((symbol) => ({ symbol, account: host.reader(symbol)?.paperAccount?.() ?? null })) }, now));
  if (path === "/v1/engine/journal") return json(200, envelope({ trades: host.symbols.flatMap((symbol) => host.reader(symbol)?.paperTrades?.() ?? []) }, now));
  if (path === "/v1/engine/demo") return json(200, envelope(host.demoStatus?.() ?? { mode: "REAL_DISABLED" }, now));
  if (path === "/v1/engine/pipeline") return json(200, envelope({ events: host.pipelineEvents?.() ?? [] }, now));
  if (path === "/v1/engine/monitoring") return host.monitoring ? json(200, envelope(host.monitoring(now), now)) : json(404, { error: "NOT_FOUND" });
  if (path === "/v1/engine/shadow") return json(200, envelope(host.shadowStatus?.() ?? { active: null, label: "UNKNOWN" }, now));
  if (path === "/v1/journal/status") return host.journalStatus ? json(200, envelope(host.journalStatus(now), now)) : json(404, { error: "NOT_FOUND" });
  if (path === "/v1/engine/readiness") return json(200, envelope({ runtime: host.journalStatus?.(now) ?? null, symbols: host.symbols.map((symbol) => host.readiness?.(symbol, now) ?? null).filter(Boolean) }, now));
  if (path === "/v1/engine/snapshot") return json(200, envelope({ bundles: host.symbols.map((symbol) => host.bundle?.(symbol, now) ?? null).filter(Boolean) }, now));
  const snr = /^\/v1\/analysis\/snr\/([A-Z0-9._]+)$/.exec(path);
  if (snr) {
    const symbol = snr[1]!;
    if (!host.symbols.includes(symbol)) return json(404, { error: "SYMBOL_NOT_HOSTED", symbol });
    const data = snrPayload(symbol, host.bundle?.(symbol, now)?.slice?.current?.operator, now);
    return data ? json(200, envelope(data, now)) : json(503, { error: "SNR_NOT_READY", symbol });
  }
  const m = /^\/v1\/engine\/([A-Z0-9._]+)\/(radar|market-context|account|journal|snapshot|readiness)$/.exec(path);
  if (!m) return json(404, { error: "NOT_FOUND" });
  const symbol = m[1]!, view = m[2]!;
  if (!host.symbols.includes(symbol)) return json(404, { error: "SYMBOL_NOT_HOSTED", symbol });
  const r = host.reader(symbol);
  if (view === "radar") return json(200, envelope({ symbol, snapshot: r?.radarSnapshot() ?? null, health: r?.radarHealth() ?? null }, now));
  if (view === "market-context") {
    const snap = r?.radarSnapshot() ?? null;
    return json(200, envelope({ symbol, report: snap?.intelligence ?? null, evaluated_bar_close: snap?.lastEvaluatedBarTime ?? null, radar_status: r?.radarHealth().status ?? "NOT_MOUNTED" }, now));
  }
  if (view === "readiness") return json(200, envelope({ symbol, readiness: host.readiness?.(symbol, now) ?? null }, now));
  if (view === "snapshot") return json(200, envelope({ symbol, bundle: host.bundle?.(symbol, now) ?? null }, now));
  if (view === "account") return json(200, envelope({ symbol, account: r?.paperAccount?.() ?? null }, now));
  return json(200, envelope({ symbol, trades: r?.paperTrades?.() ?? [] }, now));
}

export type EngineEventType = "HEALTH_UPDATE" | "MARKET_CONTEXT_UPDATE" | "RADAR_UPDATE" | "SNAPSHOT_UPDATE";
export interface EngineEvent { readonly type: EngineEventType; readonly symbol: string | null; readonly timestamp: string; readonly data: unknown }

/**
 * SSE frame builder for GET /v1/engine/events (pure; `seen` tracks the last emitted radar evaluation per symbol).
 * Emits HEALTH_UPDATE every call and RADAR_UPDATE + MARKET_CONTEXT_UPDATE only when a new CLOSED-bar evaluation exists.
 */
export function buildEngineEvents(host: HostView, now: number, seen: Map<string, number>, seenBundle: Map<string, string> = new Map()): EngineEvent[] {
  const ts = new Date(now).toISOString();
  const out: EngineEvent[] = [{ type: "HEALTH_UPDATE", symbol: null, timestamp: ts, data: host.health() }];
  for (const symbol of host.symbols) {
    const snap = host.reader(symbol)?.radarSnapshot() ?? null;
    if (!snap || seen.get(symbol) === snap.generatedAt) continue;
    seen.set(symbol, snap.generatedAt);
    out.push({ type: "RADAR_UPDATE", symbol, timestamp: ts, data: snap });
    if (snap.intelligence) out.push({ type: "MARKET_CONTEXT_UPDATE", symbol, timestamp: ts, data: snap.intelligence });
  }
  // Full per-symbol bundle (dashboard store input) only when something changed.
  if (host.bundle && host.bundleKey) for (const symbol of host.symbols) {
    const key = host.bundleKey(symbol);
    if (seenBundle.get(symbol) === key) continue;
    const b = host.bundle(symbol, now);
    if (!b) continue;
    seenBundle.set(symbol, key);
    out.push({ type: "SNAPSHOT_UPDATE", symbol, timestamp: ts, data: b });
  }
  return out;
}

export const sseFrame = (e: EngineEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
