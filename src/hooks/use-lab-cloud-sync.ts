import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import type { LabEvalEvent, LabState } from '@/core/lab/labLedger';
import { LAB_SYNC_KEY, LAB_SYNC_MS, acknowledgeJournal, newJournalQueue, pendingCount, rotateJournal, stageJournal, type JournalQueue } from '@/lib/labJournalSync';

export interface LabSyncStatus {
  status: 'LOCAL' | 'LOGIN_REQUIRED' | 'SYNCING' | 'SYNCED' | 'RETRY' | 'ACCOUNT_MISMATCH';
  pending: number; lastSyncedAt: number | null; error: string | null;
}
const initial: LabSyncStatus = { status: 'LOCAL', pending: 0, lastSyncedAt: null, error: null };
export function useLabCloudSync(state: LabState, hydrated: boolean, evals?: readonly LabEvalEvent[]) {
  const queue = useRef<JournalQueue | null>(null);
  const busy = useRef(false);
  const [sync, setSync] = useState<LabSyncStatus>(initial);
  const save = () => {
    if (queue.current) localStorage.setItem(LAB_SYNC_KEY, JSON.stringify(queue.current));
  };
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (!queue.current) {
        const raw = localStorage.getItem(LAB_SYNC_KEY);
        queue.current = raw ? JSON.parse(raw) as JournalQueue : newJournalQueue(() => crypto.randomUUID());
      }
      if (!queue.current) return;
      queue.current = stageJournal(queue.current, state, Date.now(), () => crypto.randomUUID(), evals);
      save(); // durable before any network attempt; also preserves evicted/reset local trades
      setSync(s => ({ ...s, pending: queue.current ? pendingCount(queue.current) : 0 }));
    } catch {
      setSync(s => ({ ...s, status: 'RETRY', error: 'Penyimpanan lokal penuh atau rusak; belum terkirim.' }));
    }
  }, [state, hydrated, evals]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    const flush = async () => {
      if (busy.current || !queue.current) return;
      busy.current = true;
      try {
        const { data, error } = await supabase.auth.getUser();
        if (!active) return;
        if (error && error.name !== 'AuthSessionMissingError') throw error;
        if (!data.user) {
          setSync(s => ({ ...s, status: 'LOGIN_REQUIRED', error: null })); return;
        }
        const owner = data.user.id;
        if (queue.current.sessions.some(s => s.owner !== null && s.owner !== owner)) {
          setSync(s => ({ ...s, status: 'ACCOUNT_MISMATCH', error: 'Jurnal terikat akun lain; masuk dengan akun pemilik.' })); return;
        }
        queue.current = { ...queue.current, sessions: queue.current.sessions.map(s => ({ ...s, owner })) };
        save();
        setSync(s => ({ ...s, status: 'SYNCING', error: null }));
        for (const session of [...queue.current.sessions]) {
          if (!active) break;
          const { error: sessionError } = await supabase.from('lab_journal_sessions').upsert({
            id: session.id, user_id: owner, device_id: queue.current.deviceId,
            source: 'BROWSER_PAPER', started_at_ms: session.startedAt, initial_balance: 500,
            summary: session.summary as unknown as Json, client_as_of_ms: session.asOf,
            synced_at: new Date().toISOString(),
          });
          if (sessionError) throw sessionError;
          const batch = Object.values(session.pending).slice(0, 100);
          if (batch.length) {
            const { error: tradeError } = await supabase.from('lab_journal_trades').upsert(batch.map(p => ({
              session_id: session.id, user_id: owner, trade_id: p.trade.id,
              strategy: p.trade.strategy, symbol: p.trade.symbol, side: p.trade.side,
              status: p.trade.status, pnl_usd: p.trade.pnl_usd,
              opened_at_ms: p.trade.opened_at, closed_at_ms: p.trade.closed_at,
              revision: p.revision, payload: p.trade as unknown as Json,
            })), { onConflict: 'session_id,trade_id' });
            if (tradeError) throw tradeError;
            queue.current = acknowledgeJournal(queue.current, session.id, batch);
            save();
          }
        }
        if (active) setSync({ status: pendingCount(queue.current) ? 'SYNCING' : 'SYNCED', pending: pendingCount(queue.current), lastSyncedAt: Date.now(), error: null });
      } catch {
        if (active) setSync(s => ({ ...s, status: 'RETRY', error: 'Belum terkirim; antrean lokal akan dicoba lagi.' }));
      } finally { busy.current = false; }
    };
    void flush();
    const timer = setInterval(() => void flush(), LAB_SYNC_MS);
    window.addEventListener('online', flush);
    return () => { active = false; clearInterval(timer); window.removeEventListener('online', flush); };
  }, [hydrated]);
  const rotate = () => {
    if (queue.current) { queue.current = rotateJournal(queue.current, () => crypto.randomUUID()); save(); }
  };
  return { sync, rotate };
}