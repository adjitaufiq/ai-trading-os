import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { demoBucket, demoModeRanking, demoStats, eventKey, mapRunnerTrade, netPnl, tradeFingerprint, upsertDecision } from "./demoJournal";
import type { RunnerTrade } from "./labDemoRunner";

const base: RunnerTrade = { signalId: "L11XAUabcB", strategy: "DUAL_WALL_FAST", symbol: "XAUUSD", side: "BUY", barTime: 1, status: "CLOSED", ticket: 42, volume: 0.02, requestedVolume: 0.02, requestedPrice: 2400, entry: 2400.2, sl: 2395, tp: 2405, plannedRiskUsd: 10, profile: "COPET", peakUsd: 3, trailArmed: true, openedAt: 1000, dayBaseUsd: 0, closedAt: 2000, closedDay: "2026-10-20", exitReason: "TRAIL", closeReason: null, closeAttempts: 0, pnlUsd: 4, commissionUsd: -0.14, swapUsd: 0, slippagePoints: 20, absentCycles: 0, partial: false };
const t = (o: Partial<RunnerTrade>): RunnerTrade => ({ ...base, ...o });

describe("Lab DEMO journal", () => {
  test("duplicate snapshot does not duplicate or rewrite a trade", () => {
    const fp = tradeFingerprint(base);
    expect(tradeFingerprint({ ...base })).toBe(fp);
    expect(upsertDecision(null, { fingerprint: fp, snapshot_at_ms: 1 })).toBe("INSERT");
    expect(upsertDecision({ fingerprint: fp, snapshot_at_ms: 1 }, { fingerprint: fp, snapshot_at_ms: 2 })).toBe("SKIP_DUPLICATE");
  });
  test("older snapshot never overwrites newer state; status change updates", () => {
    const fp2 = tradeFingerprint(t({ status: "OPEN" }));
    expect(upsertDecision({ fingerprint: "x", snapshot_at_ms: 5 }, { fingerprint: fp2, snapshot_at_ms: 4 })).toBe("SKIP_STALE");
    expect(upsertDecision({ fingerprint: "x", snapshot_at_ms: 5 }, { fingerprint: fp2, snapshot_at_ms: 6 })).toBe("UPDATE");
  });
  test("identical journal line ⇒ identical event key", () => {
    expect(eventKey('{"type":"A"}\n')).toBe(eventKey('{"type":"A"}'));
    expect(eventKey('{"type":"A"}')).not.toBe(eventKey('{"type":"B"}'));
  });
  test("net P/L = executor profit (already incl. commission+swap), costs never re-added", () => {
    expect(netPnl(base)).toBe(4);
    expect(netPnl(t({ pnlUsd: null }))).toBeNull();
    expect(mapRunnerTrade(t({ commissionUsd: null })).meta).toContain("komisi n/a");
  });
  test("missing commission/swap ⇒ provisional: no history row, excluded from final stats and ranking", () => {
    const v = mapRunnerTrade(t({ swapUsd: null }));
    expect(v.bucket).toBe("CLOSED_PROVISIONAL"); expect(v.row).toBeNull(); expect(v.meta).toContain("biaya belum lengkap");
    const s = demoStats([t({ swapUsd: null, pnlUsd: 20 })]);
    expect(s.closed).toBe(0); expect(s.net).toBe(0); expect(s.provisional).toBe(1); expect(s.provisionalNet).toBe(20);
    expect(demoModeRanking([t({ swapUsd: null })])).toHaveLength(0);
  });
  test("SHADOW/REJECTED/PENDING/UNKNOWN never become history rows", () => {
    for (const status of ["NOT_FILLED", "REJECTED", "PENDING", "UNKNOWN"] as const) expect(mapRunnerTrade(t({ status, entry: null, pnlUsd: null })).row).toBeNull();
    expect(demoBucket("NOT_FILLED")).toBe("SHADOW");
    expect(demoBucket("CLOSING")).toBe("OPEN");
  });
  test("partial fill and slippage are kept in broker metadata", () => {
    const v = mapRunnerTrade(t({ volume: 0.01, partial: true }));
    expect(v.row!.lot).toBe(0.01);
    expect(v.meta).toContain("0.02 → 0.01 (partial)");
    expect(v.meta).toContain("slip 20 pt");
  });
  test("open trade has no estimated floating P/L", () => {
    const v = mapRunnerTrade(t({ status: "OPEN", closedAt: null, pnlUsd: null }));
    expect(v.row!.status).toBe("OPEN");
    expect(v.row!.pnl_usd).toBe(0);
    expect(v.meta).toContain("floating broker n/a");
    expect(demoStats([t({ status: "OPEN", closedAt: null, pnlUsd: null })]).net).toBe(0);
  });
  test("stats: drawdown, loss streak, ranking from closed broker trades only", () => {
    const ts = [t({ signalId: "a", closedAt: 1, pnlUsd: 10, commissionUsd: 0 }), t({ signalId: "b", closedAt: 2, pnlUsd: -5, commissionUsd: 0 }), t({ signalId: "c", closedAt: 3, pnlUsd: -5, commissionUsd: 0 }), t({ signalId: "d", status: "NOT_FILLED", pnlUsd: null })];
    const s = demoStats(ts);
    expect(s.closed).toBe(3); expect(s.maxDrawdown).toBe(10); expect(s.maxLossStreak).toBe(2); expect(s.shadow).toBe(1); expect(s.profitFactor).toBe(1);
    expect(demoModeRanking(ts)[0]!.closed).toBe(3);
  });
  test("journal UI/endpoint/transmitter never reference broker mutation", () => {
    for (const f of ["src/routes/api/public/agent/lab-demo-journal.ts", "src/components/LabDemoJournal.tsx", "src/hooks/use-lab-demo-journal.ts", "engine-host/lab-journal-transmitter.ts", "src/core/lab/demo/demoJournal.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/sendOrder\(|closePosition\(|\/v1\/demo\/(orders|close)/);
    }
  });
});
