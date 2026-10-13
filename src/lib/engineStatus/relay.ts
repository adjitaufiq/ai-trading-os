// Engine status relay (observability only). The VPS status agent pushes a pre-filtered snapshot;
// this module re-validates it with a STRICT allowlist schema, so any extra field (balance, equity,
// login, server, positions, prices, journal, raw payloads) makes the whole push invalid. It never
// evaluates signals or gates and has no order path.
import { z } from "zod";

export const RELAY_SCHEMA = "engine-status-relay-v1" as const;
/** Heartbeat older than this ⇒ OFFLINE (agent pushes every ~15s; tolerates several missed pushes). */
export const HEARTBEAT_STALE_MS = 120_000;
export const RELAY_SYMBOLS = ["XAUUSD", "BTCUSD"] as const;

const Code = z.string().regex(/^[A-Z0-9_]{1,48}$/);

export const RelaySnapshot = z.object({
  schema: z.literal(RELAY_SCHEMA),
  engine: z.enum(["ONLINE", "DEGRADED", "OFFLINE"]),
  mode: z.enum(["MONITOR_ONLY", "DEMO_EXECUTION"]),
  execution: z.enum(["READY", "WAITING_SIGNAL", "ACTIVE", "BLOCKED", "UNKNOWN"]),
  mt5: z.enum(["CONNECTED", "DISCONNECTED", "UNKNOWN"]),
  shadow: z.enum(["CLEAR", "BLOCKING"]),
  kill_switch: z.boolean(),
  signal: z.enum(["READY", "WAITING", "UNKNOWN"]),
  stale: z.boolean(),
  phase: z.enum(["MONITOR_ONLY", "DEMO_CONNECTED", "WAITING_SETUP", "SIGNAL", "DEMO_EXECUTION"]).nullable(),
  stage: Code.nullable(),
  blockers: z.array(Code).max(12),
  symbols: z.array(z.enum(RELAY_SYMBOLS)).max(2),
  engine_checked_at: z.number().int().nonnegative(),
  /** Agent could not reach 127.0.0.1:8090 (heartbeat still proves the agent is alive). */
  engine_reachable: z.boolean(),
}).strict();
export type RelaySnapshot = z.infer<typeof RelaySnapshot>;

export const RelayPush = z.object({
  agent_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  snapshot: RelaySnapshot,
}).strict();

export interface PublicEngineStatus {
  readonly schema: typeof RELAY_SCHEMA;
  readonly status: "ONLINE" | "OFFLINE" | "NO_DATA";
  readonly heartbeat_at: number | null;
  readonly heartbeat_age_ms: number | null;
  readonly data: "FRESH" | "STALE" | "UNKNOWN";
  readonly snapshot: RelaySnapshot | null;
}

/** Live = fresh heartbeat AND agent reached the engine AND engine reports ONLINE. */
export function publicStatus(row: { received_at: string; snapshot: unknown } | null, now: number): PublicEngineStatus {
  if (!row) return { schema: RELAY_SCHEMA, status: "NO_DATA", heartbeat_at: null, heartbeat_age_ms: null, data: "UNKNOWN", snapshot: null };
  const parsed = RelaySnapshot.safeParse(row.snapshot);
  const at = Date.parse(row.received_at);
  const age = Math.max(0, now - at);
  const s = parsed.success ? parsed.data : null;
  const fresh = Number.isFinite(at) && age <= HEARTBEAT_STALE_MS;
  const online = !!s && fresh && s.engine_reachable && s.engine === "ONLINE";
  return {
    schema: RELAY_SCHEMA, status: online ? "ONLINE" : "OFFLINE", heartbeat_at: Number.isFinite(at) ? at : null,
    heartbeat_age_ms: Number.isFinite(at) ? age : null,
    data: !s || !fresh ? "UNKNOWN" : s.stale ? "STALE" : "FRESH",
    snapshot: fresh ? s : null,
  };
}

/** Debounced health transition: only a change vs the last recorded health event emits an alert. */
export function healthTransition(last: "ENGINE_ONLINE" | "ENGINE_OFFLINE" | null, st: PublicEngineStatus): "ENGINE_ONLINE" | "ENGINE_OFFLINE" | null {
  if (st.status === "NO_DATA") return null;
  const next = st.status === "ONLINE" ? "ENGINE_ONLINE" : "ENGINE_OFFLINE";
  return (last ?? "ENGINE_ONLINE") === next ? null : next;
}
