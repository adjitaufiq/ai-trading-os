import { leaderboard, type LabState, type LabTrade } from '@/core/lab/labLedger';

export const LAB_SYNC_KEY = 'strategy-lab-cloud-queue-v1';
export const LAB_SYNC_MS = 15_000;
export interface PendingTrade { trade: LabTrade; revision: number }
export interface JournalSession {
  id: string; owner: string | null; startedAt: number | null; asOf: number;
  summary: ReturnType<typeof leaderboard>; pending: Record<string, PendingTrade>;
  fingerprints: Record<string, string>; revision: number;
}
export interface JournalQueue { deviceId: string; currentId: string; sessions: JournalSession[] }
export function newJournalQueue(id: () => string): JournalQueue {
  return { deviceId: id(), currentId: '', sessions: [] };
}
export function rotateJournal(q: JournalQueue, id: () => string): JournalQueue {
  return { ...q, currentId: id() };
}
/** Copies existing observations only; never manufactures missing quotes/MAE/MFE or broker fills. */
export function stageJournal(q: JournalQueue, state: LabState, now: number, id: () => string): JournalQueue {
  const currentId = q.currentId || id();
  const old = q.sessions.find(s => s.id === currentId);
  const session: JournalSession = old ? { ...old, pending: { ...old.pending }, fingerprints: { ...old.fingerprints } } : {
    id: currentId, owner: null, startedAt: state.started_at, asOf: now,
    summary: leaderboard(state), pending: {}, fingerprints: {}, revision: 0,
  };
  for (const trade of state.trades) {
    const fingerprint = JSON.stringify(trade);
    if (session.fingerprints[trade.id] === fingerprint) continue;
    session.revision++;
    session.pending[trade.id] = { trade, revision: session.revision };
    session.fingerprints[trade.id] = fingerprint;
  }
  session.asOf = now; session.summary = leaderboard(state);
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