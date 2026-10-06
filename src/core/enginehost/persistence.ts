// Virtual-account persistence for the engine host. Storage is injected (VPS disk in production, memory in tests).
// Snapshot = atomic replace of the latest paper state. Journal = append-only JSONL mirror: rows are only ever appended,
// never rewritten or removed. Market evidence (candles, radar) is NOT persisted: it is re-bootstrapped from broker history.
import { PAPER_STATE_VERSION, type PaperLoopState } from "../paper/LivePaperLoop";

export interface EngineStorePort {
  readSnapshot(symbol: string): string | null;
  /** Must be atomic (write temp + rename) so a crash never leaves a half-written snapshot. */
  writeSnapshot(symbol: string, json: string): void;
  readJournalLines(symbol: string): readonly string[];
  appendJournalLine(symbol: string, line: string): void;
}

export class PaperPersistence {
  private readonly appended = new Map<string, Set<string>>();
  private readonly lastJson = new Map<string, string>();

  constructor(private readonly store: EngineStorePort) {}

  /** Latest valid snapshot or null. A corrupt/foreign snapshot is reported, never silently replaced by defaults. */
  load(symbol: string, dataSource: string): { state: PaperLoopState | null; error: string | null } {
    const ids = new Set<string>();
    for (const l of this.store.readJournalLines(symbol)) {
      try { const r = JSON.parse(l) as { tradeId?: unknown }; if (typeof r.tradeId === "string") ids.add(r.tradeId); } catch { /* malformed line stays in file; never rewritten */ }
    }
    this.appended.set(symbol, ids);
    const raw = this.store.readSnapshot(symbol);
    if (raw === null) return { state: null, error: null };
    try {
      const s = JSON.parse(raw) as PaperLoopState;
      if (s.version !== PAPER_STATE_VERSION) return { state: null, error: `SNAPSHOT_VERSION_UNSUPPORTED ${String(s.version)}` };
      if (s.symbol !== symbol) return { state: null, error: "SNAPSHOT_SYMBOL_MISMATCH" };
      if (s.dataSource !== dataSource) return { state: null, error: `SNAPSHOT_SOURCE_MISMATCH ${s.dataSource}≠${dataSource}` };
      this.lastJson.set(symbol, raw);
      return { state: s, error: null };
    } catch (e) {
      return { state: null, error: `SNAPSHOT_CORRUPT ${(e as Error).message}` };
    }
  }

  /** Writes only when changed. New journal rows are appended exactly once (by tradeId). */
  persist(state: PaperLoopState): boolean {
    const ids = this.appended.get(state.symbol) ?? new Set<string>();
    this.appended.set(state.symbol, ids);
    for (const row of state.journal) {
      const id = (row as { tradeId?: unknown }).tradeId;
      if (typeof id !== "string" || ids.has(id)) continue;
      this.store.appendJournalLine(state.symbol, JSON.stringify(row));
      ids.add(id);
    }
    const json = JSON.stringify(state);
    if (this.lastJson.get(state.symbol) === json) return false;
    this.store.writeSnapshot(state.symbol, json);
    this.lastJson.set(state.symbol, json);
    return true;
  }
}

/** In-memory store (tests). */
export class MemoryEngineStore implements EngineStorePort {
  readonly snapshots = new Map<string, string>();
  readonly journals = new Map<string, string[]>();
  readSnapshot(s: string) { return this.snapshots.get(s) ?? null; }
  writeSnapshot(s: string, json: string) { this.snapshots.set(s, json); }
  readJournalLines(s: string) { return [...(this.journals.get(s) ?? [])]; }
  appendJournalLine(s: string, line: string) { const a = this.journals.get(s) ?? []; a.push(line); this.journals.set(s, a); }
}
