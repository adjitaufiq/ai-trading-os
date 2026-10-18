import { describe, expect, it } from 'vitest';
import { emptyLab, markSymbol, openSignals } from '@/core/lab/labLedger';
import { acknowledgeJournal, newJournalQueue, pendingCount, rotateJournal, stageJournal } from '@/lib/labJournalSync';

let serial = 0;
const id = () => `session-${++serial}`;
const open = () => openSignals(emptyLab(), 'BTCUSD', [{ strategy: 'TOUCH_SNR', side: 'BUY', why: 'sync validation', sl_distance: 2, bar_time: 1000 }], { bid: 1000, ask: 1000 }, 1000, 'COPET');
describe('Lab cloud queue', () => {
  it('backfills existing trade with original WHY, mode and levels', () => {
    const state = open();
    const queue = stageJournal(newJournalQueue(id), state, 2000, id);
    expect(pendingCount(queue)).toBe(1);
    expect(Object.values(queue.sessions[0]?.pending ?? {})[0]?.trade).toEqual(state.trades[0]);
    expect(queue.sessions[0]?.summary.balance).toBe(500);
  });
  it('deduplicates unchanged trades and retains pending after offline reload', () => {
    const q = stageJournal(newJournalQueue(id), open(), 2000, id);
    const loaded = JSON.parse(JSON.stringify(q));
    const again = stageJournal(loaded, open(), 3000, id);
    expect(pendingCount(again)).toBe(1);
    expect(again.sessions[0]?.revision).toBe(1);
  });
  it('does not acknowledge a newer exit while an old open request is in flight', () => {
    const q = stageJournal(newJournalQueue(id), open(), 2000, id);
    const session = q.sessions[0];
    if (!session) throw new Error('missing session');
    const sent = Object.values(session.pending);
    const closed = markSymbol(open(), 'BTCUSD', { bid: 1400, ask: 1400 }, 3000);
    const updated = stageJournal(q, closed, 3000, id);
    const acknowledged = acknowledgeJournal(updated, session.id, sent);
    expect(pendingCount(acknowledged)).toBe(1);
    expect(Object.values(acknowledged.sessions[0]?.pending ?? {})[0]?.trade.exit_reason).toBe('TP');
    expect(Object.values(acknowledged.sessions[0]?.pending ?? {})[0]?.trade.pnl_usd).toBe(20);
  });
  it('keeps previous pending history when Lab is reset into a new session', () => {
    const q = stageJournal(newJournalQueue(id), open(), 2000, id);
    const reset = stageJournal(rotateJournal(q, id), emptyLab(), 3000, id);
    expect(reset.sessions).toHaveLength(2);
    expect(pendingCount(reset)).toBe(1);
    expect(reset.sessions[1]?.summary.balance).toBe(500);
  });
  it('clears exactly acknowledged revisions without resending unchanged trades', () => {
    const q = stageJournal(newJournalQueue(id), open(), 2000, id);
    const s = q.sessions[0];
    if (!s) throw new Error('missing session');
    const ack = acknowledgeJournal(q, s.id, Object.values(s.pending));
    expect(pendingCount(stageJournal(ack, open(), 4000, id))).toBe(0);
  });
});