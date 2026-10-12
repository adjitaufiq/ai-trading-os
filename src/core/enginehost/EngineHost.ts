// Persistent engine host: owns one canonical MarketRuntime per symbol for the lifetime of the VPS process,
// independent of any browser. Reuses mountCanonicalRuntime unchanged (spec + measured offset, BACKFILL history seed,
// live stream) and adds only: paper-state restore/persist and a reconnect supervisor. MONITOR_ONLY, no execution.
import type { MarketRuntime, MarketRuntimeReader } from "../runtime/MarketRuntime";
import type { MountedRuntime } from "../../lib/canonicalRuntimes";
import { deriveSymbolHealth } from "./health";
import type { PaperPersistence } from "./persistence";
import type { EngineHostHealth, EngineSymbolBundle, SymbolEngineHealth } from "./types";
import { TechnicalSliceService } from "../technical/TechnicalSliceService";
import { LiveClock } from "../temporal/CanonicalClock";
import type { ApprovedPaperOpen, PaperPipelineEvent } from "../paper/LivePaperLoop";

/** Pipeline event enriched with the radar intelligence at emission time (copy only, never recomputed). */
export interface EnginePipelineEvent extends PaperPipelineEvent {
  readonly confidence: number | null;
  readonly timeframe_context: Readonly<Record<string, string | null>>;
  readonly snapshot_ref: number | null;
}
export const PIPELINE_RING = 500;
import type { ExecutionMode } from "../execution/demo/types";
import { buildReadiness, type EngineReadiness } from "./readiness";
import { resolveBuildInfo, type EngineBuildInfo } from "./buildInfo";
import { MONITORING_SCHEMA, decisionHealth, feedState, marketDataHealth, type EngineMonitoring } from "./monitoring";
import { buildExecutionStatus, type ExecutionStatusView } from "./executionStatus";

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

/** Documented supervisor policy (operator configuration). */
export interface SupervisorPolicy { readonly tick_ms: number; readonly remount_after_ms: number; readonly backoff_min_ms: number; readonly backoff_max_ms: number }
export const ENGINE_SUPERVISOR_POLICY: SupervisorPolicy = Object.freeze({
  tick_ms: 5_000,
  /** Remount a runtime that has been OFFLINE/DEGRADED continuously for this long. */
  remount_after_ms: 180_000,
  backoff_min_ms: 30_000,
  backoff_max_ms: 600_000,
});
/** Technical slice evaluation cadence on the host (same as the former browser cockpit tick). */
export const ENGINE_SLICE_TICK_MS = 2_000;

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
  slice: TechnicalSliceService | null;
}

export class EngineHost {
  private readonly slots = new Map<string, Slot>();
  private readonly pipeline: EnginePipelineEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sliceTimer: ReturnType<typeof setInterval> | null = null;
  readonly startedAt: number;

  constructor(private readonly o: {
    symbols: readonly string[];
    mount: MountFn;
    persistence: PaperPersistence;
    now: () => number;
    log?: (msg: string) => void;
    policy?: SupervisorPolicy;
    /** Demo lab observer (Stage 10 DEMO). Receives approved paper opens; cannot alter engine state. */
    onApprovedOpen?: (e: ApprovedPaperOpen, reader: MarketRuntimeReader | null) => void;
    /** Demo lab read model for GET /v1/engine/demo. */
    demoStatus?: () => unknown;
    executionMode?: ExecutionMode;
    /** Durable sink (VPS disk outbox) for every enriched pipeline event; observer only. */
    onPipelineEvent?: (e: EnginePipelineEvent) => void;
    /** Runtime build identity reported on /v1/engine/health and /v1/engine/version. */
    build?: EngineBuildInfo;
    /** Shadow Guard read model (Phase 2A); absent ⇒ reported as UNKNOWN, never as safe. */
    shadowStatus?: () => unknown;
    /** Observed demo execution state for /v1/engine/health (label only; never gates orders). Absent ⇒ MONITOR_ONLY/false. */
    executionState?: () => { armed: boolean; enabled: boolean };
    /** Reconciler blocked flag for /v1/engine/execution-status; null when no reconciler exists. Absent ⇒ UNKNOWN. */
    reconciliationBlocked?: () => boolean | null;
    /** Kill switch observation for /v1/engine/execution-status (copy only). Absent ⇒ false only when not armed. */
    killSwitch?: () => boolean;
  }) {
    this.startedAt = o.now();
    for (const symbol of o.symbols) this.slots.set(symbol, { symbol, stop: null, rt: null, reader: null, status: "INIT", restarts: 0, unhealthySince: null, nextRemountAt: 0, backoff: this.policy.backoff_min_ms, persistError: null, slice: null });
  }

  private get policy() { return this.o.policy ?? ENGINE_SUPERVISOR_POLICY; }
  private log(m: string) { this.o.log?.(`[engine-host] ${m}`); }

  start(): void {
    for (const s of this.slots.values()) this.mountSlot(s);
    this.timer = setInterval(() => this.tick(), this.policy.tick_ms);
    this.sliceTimer = setInterval(() => this.tickSlices(), ENGINE_SLICE_TICK_MS);
  }

  /** One technical evaluation per mounted symbol (the ONLY technical evaluation when a dashboard is attached). */
  tickSlices(): void {
    for (const s of this.slots.values()) {
      if (!s.slice) continue;
      try { s.slice.tick(); } catch (e) { this.log(`${s.symbol} slice tick failed: ${(e as Error).message}`); }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sliceTimer) clearInterval(this.sliceTimer);
    this.timer = null; this.sliceTimer = null;
    for (const s of this.slots.values()) { this.persistSlot(s); s.stop?.(); s.stop = null; }
  }

  private mountSlot(s: Slot): void {
    s.rt = null; s.reader = null; s.slice = null; s.status = "INIT";
    s.stop = this.o.mount({
      symbol: s.symbol,
      onChange: (m) => {
        if (m.reader !== s.reader) s.slice = m.reader ? new TechnicalSliceService(m.reader, s.symbol, new LiveClock(this.o.now)) : null;
        s.reader = m.reader; s.status = m.status;
      },
      onRuntime: (rt) => {
        // restore BEFORE start(): the paper loop has not seen any CLOSED bar yet
        const ds = rt.paperState().dataSource;
        const { state, error } = this.o.persistence.load(s.symbol, ds);
        if (error) { s.persistError = error; this.log(`${s.symbol} snapshot not restored: ${error}`); }
        if (state) { rt.restorePaperState(state); this.log(`${s.symbol} restored paper state (${state.journal.length} journal rows)`); }
        rt.onPaperPipelineEvent?.((e) => this.recordPipeline(e, s.reader));
        if (this.o.onApprovedOpen) rt.onApprovedPaperOpen((e) => this.o.onApprovedOpen?.(e, s.reader));
        s.rt = rt;
      },
    });
  }

  private recordPipeline(e: PaperPipelineEvent, reader: MarketRuntimeReader | null): void {
    const snap = reader?.radarSnapshot() ?? null, i = snap?.intelligence;
    const ev: EnginePipelineEvent = Object.freeze({
      ...e, confidence: i?.confidence ?? null, snapshot_ref: snap?.generatedAt ?? null,
      timeframe_context: Object.freeze({ bias: i?.bias ?? null, h4: i?.h4_state ?? null, h1: i?.h1_state ?? null, m15: i?.m15_condition ?? null, m5: i?.m5_condition ?? null, regime: snap?.regime.type ?? null, decision: i?.status ?? null }),
    });
    this.pipeline.push(ev);
    try { this.o.onPipelineEvent?.(ev); } catch (x) { this.log(`pipeline sink failed ${(x as Error).message}`); }
    if (this.pipeline.length > PIPELINE_RING) this.pipeline.splice(0, this.pipeline.length - PIPELINE_RING);
    this.log(`${e.symbol} pipeline ${e.type}/${e.stage} ${e.direction ?? ""} ${e.reason}`);
  }

  /** Bounded in-memory pipeline log (READY/BLOCKED/EXECUTION/EXIT) for cloud capture. */
  pipelineEvents(): readonly EnginePipelineEvent[] { return [...this.pipeline]; }

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
    let ex: { armed: boolean; enabled: boolean } = { armed: false, enabled: false };
    try { ex = this.o.executionState?.() ?? ex; } catch { /* fail-closed: report disabled */ }
    return Object.freeze({
      operating_mode: ex.armed ? "DEMO" as const : "MONITOR_ONLY" as const, execution_enabled: ex.armed && ex.enabled,
      started_at: this.startedAt, persistence: "VPS_DISK" as const,
      demo_execution: this.o.executionMode ?? "REAL_DISABLED",
      symbols: Object.freeze([...this.slots.values()].map((s) => this.symbolHealth(s, now))),
      build: this.buildInfo(),
      shadow: this.shadowStatus(),
    });
  }

  shadowStatus(): unknown { return this.o.shadowStatus?.() ?? { active: null, label: "UNKNOWN" }; }

  /** Read-only execution status projection (copies only; never gates orders). */
  executionStatus(now: number): ExecutionStatusView {
    let ex: { armed: boolean; enabled: boolean } = { armed: false, enabled: false };
    try { ex = this.o.executionState?.() ?? ex; } catch { /* fail-closed */ }
    let killed = false;
    try { killed = this.o.killSwitch?.() ?? false; } catch { killed = true; }
    let reconBlocked: boolean | null = null;
    try { reconBlocked = this.o.reconciliationBlocked?.() ?? null; } catch { reconBlocked = null; }
    const shadow = rec(this.shadowStatus());
    return buildExecutionStatus({
      now,
      symbols: [...this.slots.values()].map((s) => this.symbolHealth(s, now)),
      armed: ex.armed,
      shadowActive: shadow?.["active"] === true,
      killSwitch: killed,
      demo: this.o.demoStatus ? this.o.demoStatus() : null,
      reconciliationBlocked: reconBlocked,
      readiness: [...this.slots.keys()].map((symbol) => this.readiness(symbol, now)),
    });
  }

  /** Phase 2B monitoring projection (copies only). */
  monitoring(now: number): EngineMonitoring {
    const syms = [...this.slots.values()].map((s) => {
      const engine = this.symbolHealth(s, now);
      return Object.freeze({ symbol: s.symbol, engine, feed: feedState(s.reader, now), market_data: marketDataHealth(s.reader, now), decision: decisionHealth(s.reader?.paperReadiness?.() ?? null) });
    });
    const times = syms.map((x) => x.decision.last_analysis_at).filter((t): t is number => t !== null);
    return Object.freeze({
      schema: MONITORING_SCHEMA, engine_status: syms.some((x) => x.engine.state !== "OFFLINE") ? "ONLINE" as const : "OFFLINE" as const,
      build: this.buildInfo(), started_at: this.startedAt, last_process_at: times.length ? Math.max(...times) : null,
      last_error: syms.find((x) => x.engine.error)?.engine.error ?? null, shadow: this.shadowStatus(), symbols: Object.freeze(syms),
    });
  }

  /** Phase 2E journal/storage status: VPS disk persistence per symbol + shadow journal. Cloud DB is not observable here. */
  journalStatus(now: number) {
    const m = this.monitoring(now);
    return Object.freeze({
      build: m.build, shadow: m.shadow, last_analysis_at: m.last_process_at,
      database: Object.freeze({
        engine_storage: "VPS_DISK" as const,
        status: [...this.slots.values()].some((s) => s.persistError) ? "ERROR" as const : "OK" as const,
        cloud_database: "NOT_OBSERVABLE_FROM_HOST" as const,
        symbols: [...this.slots.values()].map((s) => ({ symbol: s.symbol, persist_error: s.persistError, journal_rows: s.reader?.paperTrades?.().length ?? null })),
      }),
    });
  }

  buildInfo(): EngineBuildInfo { return this.o.build ?? resolveBuildInfo(null); }

  demoStatus(): unknown { return this.o.demoStatus?.() ?? { mode: this.o.executionMode ?? "REAL_DISABLED" }; }

  /** Read-only readiness projection (copies existing state; no evaluation). */
  readiness(symbol: string, now: number): EngineReadiness | null {
    const s = this.slots.get(symbol);
    if (!s) return null;
    return buildReadiness({ symbol, now, health: this.symbolHealth(s, now), executionMode: this.o.executionMode ?? "REAL_DISABLED",
      paper: s.reader?.paperReadiness?.() ?? null, demo: this.o.demoStatus ? this.o.demoStatus() : null });
  }

  reader(symbol: string): MarketRuntimeReader | null { return this.slots.get(symbol)?.reader ?? null; }

  /** Complete per-symbol read model for the dashboard (view layer only). */
  bundle(symbol: string, now: number): EngineSymbolBundle | null {
    const s = this.slots.get(symbol);
    if (!s) return null;
    const r = s.reader;
    const live = r?.latestLiveObservation() ?? null;
    return Object.freeze({
      symbol, source: "ENGINE_HOST" as const, timestamp: now,
      health: this.symbolHealth(s, now),
      slice: s.slice?.view() ?? null,
      radar: Object.freeze({ snapshot: r?.radarSnapshot() ?? null, health: r?.radarHealth() ?? null }),
      account: r?.paperAccount?.() ?? null,
      trades: r?.paperTrades?.() ?? [],
      live: live ? Object.freeze({ source: live.source, bid: live.bid, ask: live.ask, event_at: live.event_at, observed_at: live.observed_at }) : null,
      last_m5_close: r?.closedBars("M5").at(-1)?.close_time ?? null,
    });
  }

  /** Change key for SSE dedup (slice version + radar evaluation + account). */
  bundleKey(symbol: string): string {
    const s = this.slots.get(symbol);
    const a = s?.reader?.paperAccount?.();
    return `${s?.slice?.getVersion() ?? -1}:${s?.reader?.radarSnapshot()?.generatedAt ?? -1}:${a?.balance ?? ""}:${a?.openPositions ?? ""}:${s?.status ?? ""}`;
  }
  get symbols(): readonly string[] { return [...this.slots.keys()]; }
}
