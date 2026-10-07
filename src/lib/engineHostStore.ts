// Dashboard-side store for the persistent engine host (Phase 2.1: dashboard = view layer only).
// Update order is SSE event → store update → React render (useSyncExternalStore); there is no render polling.
// A slow watchdog only decides ownership (LIVE vs OFFLINE fallback) and re-syncs snapshots after a gap.
// Read-only: GET + EventSource only. MONITOR_ONLY, no order path.
import { EngineHostClient, isBundle, isEngineHostHealth } from "@/core/enginehost/client";
import type { EngineHostHealth, EngineSymbolBundle } from "@/core/enginehost/types";

/** DISABLED = no engine host URL; CHECKING = first attach attempt; LIVE = engine host owns every view; OFFLINE = browser fallback. */
export type EngineAttachStatus = "DISABLED" | "CHECKING" | "LIVE" | "OFFLINE";

export const ENGINE_ATTACH_POLICY = Object.freeze({
  watchdog_ms: 5_000,
  /** No SSE frame for this long ⇒ verify health and re-sync snapshots. */
  silence_ms: 15_000,
  /** Consecutive failed checks before LIVE → OFFLINE (anti-flicker hysteresis). */
  fail_threshold: 3,
  /** Re-probe cadence while OFFLINE. */
  probe_ms: 15_000,
});

export interface EventSourceLike {
  addEventListener(type: string, cb: (e: { data: string }) => void): void;
  close(): void;
  onerror: ((e: unknown) => void) | null;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface EngineStoreState {
  readonly status: EngineAttachStatus;
  readonly health: EngineHostHealth | null;
  readonly bundles: Readonly<Record<string, EngineSymbolBundle>>;
  readonly error: string | null;
  readonly lastEventAt: number | null;
}

export class EngineHostStore {
  private state: EngineStoreState;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private es: EventSourceLike | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fails = 0;
  private lastProbe = 0;
  private busy = false;

  constructor(private readonly o: {
    client: EngineHostClient | null;
    symbols: readonly string[];
    now: () => number;
    eventSource?: EventSourceFactory | null;
    policy?: typeof ENGINE_ATTACH_POLICY;
  }) {
    this.state = { status: o.client ? "CHECKING" : "DISABLED", health: null, bundles: {}, error: null, lastEventAt: null };
  }

  private get p() { return this.o.policy ?? ENGINE_ATTACH_POLICY; }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  getState = () => this.state;
  private set(patch: Partial<EngineStoreState>) {
    this.state = { ...this.state, ...patch };
    this.version++;
    for (const l of this.listeners) l();
  }

  async start(): Promise<void> {
    if (!this.o.client) return;
    await this.sync();
    this.timer = setInterval(() => void this.watchdog(), this.p.watchdog_ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.es?.close(); this.es = null;
  }

  /** Health + all snapshots in one pass; decides ownership. */
  async sync(): Promise<boolean> {
    const c = this.o.client;
    if (!c || this.busy) return false;
    this.busy = true;
    try {
      this.lastProbe = this.o.now();
      const [h, s] = await Promise.all([c.health(), c.snapshots()]);
      if (!h.ok || !s.ok) return this.fail(!h.ok ? h.error : (s as { error: string }).error);
      const hosted = new Set(h.envelope.data.symbols.map((x) => x.symbol));
      const missing = this.o.symbols.filter((x) => !hosted.has(x));
      if (missing.length) return this.fail(`SYMBOL_NOT_HOSTED ${missing.join(",")}`);
      const bundles: Record<string, EngineSymbolBundle> = {};
      for (const b of s.envelope.data.bundles) if (this.o.symbols.includes(b.symbol)) bundles[b.symbol] = b;
      this.fails = 0;
      this.set({ status: "LIVE", health: h.envelope.data, bundles, error: null, lastEventAt: this.o.now() });
      this.openStream();
      return true;
    } finally { this.busy = false; }
  }

  private fail(error: string): false {
    this.fails++;
    // CHECKING resolves to OFFLINE immediately; LIVE only after the hysteresis threshold.
    const drop = this.state.status !== "LIVE" || this.fails >= this.p.fail_threshold;
    if (drop) { this.es?.close(); this.es = null; this.set({ status: "OFFLINE", error, bundles: {}, health: null }); }
    else this.set({ error });
    return false;
  }

  private openStream() {
    if (this.es || !this.o.eventSource || !this.o.client) return;
    const es = this.o.eventSource(this.o.client.eventsUrl);
    this.es = es;
    const parse = (raw: string): { symbol: string | null; data: unknown } | null => { try { return JSON.parse(raw) as { symbol: string | null; data: unknown }; } catch { return null; } };
    es.addEventListener("SNAPSHOT_UPDATE", (e) => {
      const ev = parse(e.data);
      if (!ev || !isBundle(ev.data) || ev.data.symbol !== ev.symbol || !this.o.symbols.includes(ev.data.symbol) || this.state.status !== "LIVE") return;
      this.set({ bundles: { ...this.state.bundles, [ev.data.symbol]: ev.data }, lastEventAt: this.o.now() });
    });
    es.addEventListener("HEALTH_UPDATE", (e) => {
      const ev = parse(e.data);
      if (!ev || !isEngineHostHealth(ev.data) || this.state.status !== "LIVE") return;
      this.set({ health: ev.data, lastEventAt: this.o.now() });
    });
    es.onerror = () => { /* EventSource retries itself; silence is handled by the watchdog */ };
  }

  async watchdog(): Promise<void> {
    const now = this.o.now();
    if (this.state.status === "LIVE") {
      if (this.state.lastEventAt !== null && now - this.state.lastEventAt < this.p.silence_ms) return;
      this.es?.close(); this.es = null;
      await this.sync();
    } else if (this.state.status === "OFFLINE" && now - this.lastProbe >= this.p.probe_ms) {
      await this.sync();
    }
  }
}

export function browserEventSource(): EventSourceFactory | null {
  return typeof EventSource === "undefined" ? null : (url) => new EventSource(url) as unknown as EventSourceLike;
}
