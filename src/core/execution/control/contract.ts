// Cloud control plane contract (Step 2). Configuration + observability only:
// the cloud never talks to the broker. The VPS agent PULLs config and PUSHes heartbeat/events,
// every request HMAC-signed with EXECUTION_AGENT_SECRET. Pure + Web Crypto (Bun and Workers).
import { DEMO_RISK_PROFILE, parseExecutionMode, type DemoRiskProfile, type ExecutionMode } from "../demo/types";

export const CONTROL_CONTRACT_VERSION = "control-plane-v1" as const;
export const SIGNATURE_MAX_SKEW_MS = 5 * 60_000;

export interface ExecutionConfigWire {
  readonly execution_mode: string; readonly demo_enabled: boolean; readonly kill_switch: boolean;
  readonly risk_percent: number; readonly max_open_positions: number; readonly max_daily_loss_percent: number;
  readonly max_daily_trades: number; readonly allowed_symbols: readonly string[]; readonly updated_at: string;
}

export interface AgentHeartbeat {
  readonly agent_id: string; readonly mt5_connected: boolean; readonly account_mode: string | null;
  readonly account_number_masked: string | null; readonly broker_server: string | null;
  readonly execution_mode: string; readonly open_positions: number | null;
  readonly current_version: string | null; readonly last_error: string | null;
}

export interface AgentExecutionEvent {
  readonly type: string; readonly at: number; readonly signal_id: string | null; readonly symbol: string | null; readonly detail?: string;
}

/** What the agent is allowed to do right now. Fail-closed: anything missing/unknown ⇒ halted. */
export interface DerivedControl {
  readonly halted: boolean; readonly reason: string; readonly mode: ExecutionMode;
  readonly profile: DemoRiskProfile; readonly allowedSymbols: readonly string[];
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};

export function deriveControl(cfg: ExecutionConfigWire | null | undefined, legacyStopped = false): DerivedControl {
  if (!cfg) return { halted: true, reason: "CONFIG_UNAVAILABLE", mode: "REAL_DISABLED", profile: DEMO_RISK_PROFILE, allowedSymbols: [] };
  const mode = parseExecutionMode(cfg.execution_mode);
  const profile: DemoRiskProfile = Object.freeze({
    riskPercent: clamp(cfg.risk_percent, 0.01, 2, DEMO_RISK_PROFILE.riskPercent),
    maxOpenPositions: Math.floor(clamp(cfg.max_open_positions, 1, 5, DEMO_RISK_PROFILE.maxOpenPositions)),
    maxTradesPerDay: Math.floor(clamp(cfg.max_daily_trades, 1, 50, DEMO_RISK_PROFILE.maxTradesPerDay)),
    maxDailyLossPercent: clamp(cfg.max_daily_loss_percent, 0.01, 10, DEMO_RISK_PROFILE.maxDailyLossPercent),
  }) as DemoRiskProfile;
  const allowedSymbols = Array.isArray(cfg.allowed_symbols) ? cfg.allowed_symbols.map((s) => String(s).toUpperCase()) : [];
  const reason = cfg.kill_switch !== false ? "KILL_SWITCH"
    : legacyStopped ? "DEMO_LAB_STOPPED"
    : mode !== "DEMO_STRESS_TEST" ? `MODE_${mode}`
    : cfg.demo_enabled !== true ? "DEMO_DISABLED"
    : "";
  return { halted: reason !== "", reason: reason || "ARMED", mode, profile, allowedSymbols };
}

export function maskAccount(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\D/g, "");
  if (!s) return null;
  return s.length <= 3 ? "***" : `${"*".repeat(Math.max(3, s.length - 3))}${s.slice(-3)}`;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const canonicalString = (ts: string, method: string, path: string, body: string) => `${ts}\n${method.toUpperCase()}\n${path}\n${body}`;

export async function signRequest(secret: string, ts: string, method: string, path: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(canonicalString(ts, method, path, body))));
}

export async function verifyRequest(secret: string | undefined, o: { ts: string | null; sig: string | null; method: string; path: string; body: string; now: number }): Promise<boolean> {
  if (!secret || !o.ts || !o.sig) return false;
  const t = Number(o.ts);
  if (!Number.isFinite(t) || Math.abs(o.now - t) > SIGNATURE_MAX_SKEW_MS) return false;
  const expected = await signRequest(secret, o.ts, o.method, o.path, o.body);
  if (expected.length !== o.sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ o.sig.charCodeAt(i);
  return diff === 0;
}
