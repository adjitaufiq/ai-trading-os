// The single typed boundary for gateway location. No broker credentials live here:
// a gateway URL carrying userinfo is rejected.

/**
 * Configured gateway TARGET label (product configuration, not verified state).
 * Verified source/source_mode always come from validated wire envelopes. FAKE_MT5_LOCAL is test-only.
 */
export type GatewayEnvironment = "EXNESS_MT5_GATEWAY" | "FAKE_MT5_LOCAL";

export interface GatewayConfig {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly timeoutMs: number;
  readonly environment: GatewayEnvironment;
}

export class GatewayConfigError extends Error {}

function check(url: string, schemes: readonly string[]): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GatewayConfigError("gateway URL is not a valid URL");
  }
  if (!schemes.includes(u.protocol)) throw new GatewayConfigError(`gateway URL scheme must be ${schemes.join("/")}`);
  if (u.username || u.password) throw new GatewayConfigError("gateway URL must not carry credentials");
  if (u.search || u.hash) throw new GatewayConfigError("gateway URL must not carry query or fragment");
  return url.replace(/\/+$/, "");
}

/** WS base derived from the HTTP origin (https → wss, http → ws), same host/port/path. */
export function deriveWsBaseUrl(httpBaseUrl: string): string {
  const u = new URL(httpBaseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/+$/, "");
}

export function makeGatewayConfig(p: Partial<GatewayConfig> = {}): GatewayConfig {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const timeoutMs = p.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new GatewayConfigError("timeoutMs must be > 0");
  const httpBaseUrl = check(p.httpBaseUrl ?? (env["VITE_MT5_GATEWAY_URL"] || undefined) ?? env["VITE_GATEWAY_HTTP_URL"] ?? "http://127.0.0.1:8000", ["http:", "https:"]);
  const wsExplicit = p.wsBaseUrl ?? (env["VITE_GATEWAY_WS_URL"] || undefined);
  return Object.freeze({
    httpBaseUrl,
    wsBaseUrl: check(wsExplicit ?? deriveWsBaseUrl(httpBaseUrl), ["ws:", "wss:"]),
    timeoutMs,
    environment: p.environment ?? "EXNESS_MT5_GATEWAY",
  });
}
