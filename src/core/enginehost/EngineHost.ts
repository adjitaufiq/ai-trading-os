// Persistent engine host: owns one canonical MarketRuntime per symbol for the lifetime of the VPS process,
// independent of any browser. Reuses mountCanonicalRuntime unchanged (spec + measured offset, BACKFILL history seed,
// live stream) and adds only: paper-state restore/persist and a reconnect supervisor. MONITOR_ONLY, no execution.
import type { MarketRuntime, MarketRuntimeReader } from "../runtime/MarketRuntime";
import type { MountedRuntime } from "../../lib/canonicalRuntimes";
import { deriveSymbolHealth } from "./health";
import type { PaperPersistence } from "./persistence";
import type { EngineHostHealth, SymbolEngineHealth } from "./types";

/** Documented supervisor policy (operator configuration). */
export const ENGINE_SUPERVISOR_POLICY = Object.freeze({
  tick_ms: 5_000,
  /** Remount a runtime that has been OFFLINE/DEGRADED continuously for this long. */
  remount_after_ms: 180_000,
  backoff_min_ms: 30_000,
  backoff_max_ms: 600_000,
});

export type MountFn = (o: { symbol: string; onChange: (m: MountedRuntime) => void; onRuntime: (rt: MarketRuntime) => void }) => () => void;

interface Slot {
  symbol: string;
  stop: (() => void) | null;
  rt: MarketRuntime | null;
  reader: MarketRuntimeReader | null;
  status: string;
  restarts: number;
  unhealthySince: number | null;
  nextRemountAt: number;
  backoff: number;
  persistError: string | null;
}

export class EngineHost {
  private readonly slots = new Map<string, Slot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly startedAt: number;

  constructor(private readonly o: {
    symbols: readonly string[];
    mount: MountFn;
    persistence: PaperPersistence;
    now: () => number;
    log?: (msg: string) => void;
    policy?: typeof ENGINE_SUPERVISOR_POLICY;
  }) {
    this.startedAt = o.now();
    for (const symbol of o.symbols) this.slots.set(symbol, { symbol, stop: null, rt: null, reader: null, status: "INIT", restarts: 0, unhealthySince: null, nextRemountAt: 0, backoff: this.policy.backoff_min_ms, persistError: null });
  }

  private get policy() { return this.o.policy ?? ENGINE_SUPERVISOR_POLICY; }
  private log(m: string) { this.o.log?.(`[engine-host] ${m}`); }

  start(): void {
    for (const s of this.slots.values()) this.mountSlot(s);
    this.timer = setInterval(() => this.tick(), this.policy.tick_ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.slots.values()) { this.persistSlot(s); s.stop?.(); s.stop = null; }
  }

  private mountSlot(s: Slot): void {
    s.rt = null; s.reader = null; s.status = "INIT";
    s.stop = this.o.mount({
      symbol: s.symbol,
      onChange: (m) => { s.reader = m.reader; s.status = m.status; },
      onRuntime: (rt) => {
        // restore BEFORE start(): the paper loop has not seen any CLOSED bar yet
        const ds = rt.paperState().dataSource;
        const { state, error } = this.o.persistence.load(s.symbol, ds);
        if (error) { s.persistError = error; this.log(`${s.symbol} snapshot not restored: ${error}`); }
        if (state) { rt.restorePaperState(state); this.log(`${s.symbol} restored paper state (${state.journal.length} journal rows)`); }
        s.rt = rt;
      },
    });
  }

  private persistSlot(s: Slot): void {
    if (!s.rt) return;
    try { this.o.persistence.persist(s.rt.paperState()); s.persistError = null; }
    catch (e) { s.persistError = `PERSIST_FAILED ${(e as Error).message}`; this.log(`${s.symbol} ${s.persistError}`); }
  }

  /** One supervisor step (exposed for tests). */
  tick(): void {
    const now = this.o.now();
    for (const s of this.slots.values()) {
      this.persistSlot(s);
      const h = this.symbolHealth(s, now);
      const bad = h.state === "OFFLINE" || h.state === "DEGRADED";
      if (!bad) { s.unhealthySince = null; s.backoff = this.policy.backoff_min_ms; continue; }
      s.unhealthySince ??= now;
      if (now - s.unhealthySince < this.policy.remount_after_ms || now < s.nextRemountAt) continue;
      this.log(`${s.symbol} ${h.state} (${h.error ?? "?"}) for ${Math.round((now - s.unhealthySince) / 1000)}s → remount`);
      this.persistSlot(s);
      s.stop?.();
      s.restarts++;
      s.unhealthySince = null;
      s.nextRemountAt = now + s.backoff;
      s.backoff = Math.min(s.backoff * 2, this.policy.backoff_max_ms);
      this.mountSlot(s);
    }
  }

  private symbolHealth(s: Slot, now: number): SymbolEngineHealth {
    const h = deriveSymbolHealth({ symbol: s.symbol, reader: s.reader, mount_status: s.status, restarts: s.restarts, now });
    return s.persistError && !h.error ? Object.freeze({ ...h, error: s.persistError }) : h;
  }

  health(): EngineHostHealth {
    const now = this.o.now();
    return Object.freeze({
      operating_mode: "MONITOR_ONLY", execution_enabled: false, started_at: this.startedAt, persistence: "VPS_DISK",
      symbols: Object.freeze([...this.slots.values()].map((s) => this.symbolHealth(s, now))),
    });
  }

  reader(symbol: string): MarketRuntimeReader | null { return this.slots.get(symbol)?.reader ?? null; }
  get symbols(): readonly string[] { return [...this.slots.keys()]; }
}
