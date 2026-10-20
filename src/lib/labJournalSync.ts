import { leaderboard, type LabEvalEvent, type LabState, type LabTrade } from '@/core/lab/labLedger';

export const LAB_SYNC_KEY = 'strategy-lab-cloud-queue-v1';
export const LAB_SYNC_MS = 15_000;
/** Evaluation events copied into the session summary (rolling window; full log stays local, append-only by id). */
export const LAB_EVAL_CLOUD_WINDOW = 400;
export interface PendingTrade { trade: LabTrade; revision: number }
export type JournalSummary = ReturnType<typeof leaderboard> & { eval_events?: LabEvalEvent[]; eval_window?: number };
export interface JournalSession {
  id: string; owner: string | null; startedAt: number | null; asOf: number;
  summary: JournalSummary; pending: Record<string, PendingTrade>;
  fingerprints: Record<string, string>; revision: number;
}
export interface JournalQueue { deviceId: string; currentId: string; sessions: JournalSession[] }
export function newJournalQueue(id: () => string): JournalQueue {
  return { deviceId: id(), currentId: '', sessions: [] };
}
export function rotateJournal(q: JournalQueue, id: () => string): JournalQueue {
  return { ...q, currentId: id() };
}
function summaryOf(state: LabState, evals: readonly LabEvalEvent[] | undefined, startedAt: number | null): JournalSummary {
  const base = leaderboard(state);
  if (!evals) return base;
  // Only evaluations that belong to this session (at or after its start) are copied.
  const mine = evals.filter((e) => startedAt == null || e.at >= startedAt).slice(-LAB_EVAL_CLOUD_WINDOW);
  return { ...base, eval_events: mine, eval_window: LAB_EVAL_CLOUD_WINDOW };
}
/** Copies existing observations only; never manufactures missing quotes/MAE/MFE or broker fills. */
export function stageJournal(q: JournalQueue, state: LabState, now: number, id: () => string, evals?: readonly LabEvalEvent[]): JournalQueue {
  const currentId = q.currentId || id();
  const old = q.sessions.find(s => s.id === currentId);
  const session: JournalSession = old ? { ...old, pending: { ...old.pending }, fingerprints: { ...old.fingerprints } } : {
    id: currentId, owner: null, startedAt: state.started_at, asOf: now,
    summary: summaryOf(state, evals, state.started_at), pending: {}, fingerprints: {}, revision: 0,
  };
  for (const trade of state.trades) {
    const fingerprint = JSON.stringify(trade);
    if (session.fingerprints[trade.id] === fingerprint) continue;
    session.revision++;
    session.pending[trade.id] = { trade, revision: session.revision };
    session.fingerprints[trade.id] = fingerprint;
  }
  session.asOf = now; session.summary = summaryOf(state, evals, session.startedAt ?? state.started_at);
  return { ...q, currentId, sessions: [...q.sessions.filter(s => s.id !== currentId), session] };
}
export function acknowledgeJournal(q: JournalQueue, sessionId: string, sent: readonly PendingTrade[]): JournalQueue {
  return { ...q, sessions: q.sessions.map(s => {
    if (s.id !== sessionId) return s;
    const pending = { ...s.pending };
    for (const p of sent) if (pending[p.trade.id]?.revision === p.revision) delete pending[p.trade.id];
    return { ...s, pending };
  }) };
}
export const pendingCount = (q: JournalQueue) => q.sessions.reduce((n, s) => n + Object.keys(s.pending).length, 0);
