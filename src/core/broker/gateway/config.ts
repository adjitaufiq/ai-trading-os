// The single typed boundary for gateway location. No broker credentials live here:
// a gateway URL carrying userinfo is rejected.

export type GatewayEnvironment = "FAKE_MT5_LOCAL";

export interface GatewayConfig {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly timeoutMs: number;
  /** Acceptance environment label shown in UI. Stage 3.0B-2C: always fake. */
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

export function makeGatewayConfig(p: Partial<Omit<GatewayConfig, "environment">> = {}): GatewayConfig {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const timeoutMs = p.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new GatewayConfigError("timeoutMs must be > 0");
  return Object.freeze({
    httpBaseUrl: check(p.httpBaseUrl ?? env["VITE_GATEWAY_HTTP_URL"] ?? "http://127.0.0.1:8000", ["http:", "https:"]),
    wsBaseUrl: check(p.wsBaseUrl ?? env["VITE_GATEWAY_WS_URL"] ?? "ws://127.0.0.1:8000", ["ws:", "wss:"]),
    timeoutMs,
    environment: "FAKE_MT5_LOCAL",
  });
}
