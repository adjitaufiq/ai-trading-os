// Single-instance guard (pure decision). The engine host must refuse to start — before wiring any runtime,
// reconciler or order path — when another engine host already owns the API port or a live lock file.
export interface InstanceLock { readonly pid: number; readonly port: number; readonly started_at: number }

export type InstanceDecision =
  | { readonly start: true; readonly stale_lock: boolean }
  | { readonly start: false; readonly reason: "PORT_IN_USE" | "LOCK_HELD_BY_LIVE_PROCESS" };

export function decideInstance(i: {
  readonly portInUse: boolean;
  readonly lockRaw: string | null;
  readonly selfPid: number;
  readonly isPidAlive: (pid: number) => boolean;
}): InstanceDecision {
  if (i.portInUse) return { start: false, reason: "PORT_IN_USE" };
  if (i.lockRaw === null) return { start: true, stale_lock: false };
  let lock: Partial<InstanceLock> | null = null;
  try { lock = JSON.parse(i.lockRaw) as Partial<InstanceLock>; } catch { lock = null; }
  const pid = typeof lock?.pid === "number" ? lock.pid : null;
  if (pid !== null && pid !== i.selfPid && i.isPidAlive(pid)) return { start: false, reason: "LOCK_HELD_BY_LIVE_PROCESS" };
  return { start: true, stale_lock: true };
}
