// AI Context Builder (server-only). Reads the live Engine Host snapshot and produces a compact, per-symbol,
// read-only fact sheet. Never sends raw candles; never mixes symbols in a symbol-scoped thread.
import { EngineHostClient } from "@/core/enginehost/client";
import type { EngineSymbolBundle } from "@/core/enginehost/types";

function engineUrl(): string | null {
  const v = (import.meta.env["VITE_ENGINE_HOST_URL"] as string | undefined) ?? process.env["VITE_ENGINE_HOST_URL"];
  return v && v.trim() ? v.trim() : null;
}

function iso(ms: number | null | undefined) { return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null; }

function summarizeBundle(b: EngineSymbolBundle) {
  const s = b.radar.snapshot;
  const cur = b.slice?.current ?? b.slice?.last_known ?? null;
  const closed = b.trades.slice(-5);
  return {
    symbol: b.symbol,
    source: b.source,
    snapshot_at: iso(b.timestamp),
    engine_state: b.health?.state ?? null,
    radar_status: b.health?.radar_status ?? b.radar.health?.status ?? null,
    mount_status: b.health?.mount_status ?? null,
    last_m5_close: iso(b.last_m5_close),
    live_quote: b.live ? { bid: b.live.bid, ask: b.live.ask, source: b.live.source, at: iso(b.live.event_at) } : null,
    data_source: s?.validationSource.dataSource ?? null,
    regime: s ? { type: s.regime.type, h4_bias: s.regime.h4Bias, h1_phase: s.regime.h1Phase, evidence: s.regime.evidence.slice(0, 6) } : null,
    horizon: s ? { compatible: s.horizon.compatibleHorizons, approach: s.horizon.marketApproach, veto: s.horizon.vetoReason } : null,
    footprint_tags: s?.footprints.activeTags ?? [],
    last_sweep: s?.footprints.lastSweep ?? null,
    active_events: s?.activeEvents.map((e) => ({ type: e.type, severity: e.severity, tf: e.timeframe, age_bars: e.ageBars })) ?? [],
    session: s?.session ?? null,
    market_context: s?.intelligence ? {
      bias: s.intelligence.bias, phase: s.intelligence.market_phase, h4: s.intelligence.h4_state, h1: s.intelligence.h1_state,
      m15: s.intelligence.m15_condition, m5: s.intelligence.m5_condition, setup: s.intelligence.setup, status: s.intelligence.status,
      confidence: s.intelligence.confidence, risk: s.intelligence.risk_assessment, key_levels: s.intelligence.key_levels,
      confirmation_needed: s.intelligence.confirmation_needed, invalidation: s.intelligence.invalidation_conditions,
      audit_trail: s.intelligence.audit_trail.slice(0, 8),
    } : null,
    technical_state: cur ? JSON.stringify(cur).slice(0, 3000) : null,
    paper_account: b.account ? { balance: b.account.balance, equity: b.account.equity, open: b.account.openPositions, closed: b.account.closedTrades, realized: b.account.realizedPnL, unrealized: b.account.unrealizedPnL, drawdown_pct: b.account.drawdownPercent, data_source: b.account.dataSource } : null,
    recent_trades: closed.map((t) => JSON.stringify(t).slice(0, 400)),
  };
}

/** scope = XAUUSD | BTCUSD ⇒ only that symbol. ENGINE ⇒ health of all symbols (labelled). KNOWLEDGE ⇒ radar summary per symbol, labelled separately. */
export async function buildLiveContext(scope: string): Promise<string> {
  const url = engineUrl();
  if (!url) return "LIVE_CONTEXT: UNAVAILABLE (engine host belum dikonfigurasi). Jangan mengarang kondisi pasar.";
  const client = new EngineHostClient({ baseUrl: url, timeoutMs: 6_000 });
  const res = await client.snapshots();
  if (!res.ok) return `LIVE_CONTEXT: UNAVAILABLE (engine host ${res.error}). Jangan mengarang kondisi pasar.`;
  const bundles = res.envelope.data.bundles;
  const header = `LIVE_CONTEXT source=ENGINE_HOST generated_at=${iso(res.envelope.generated_at)} operating_mode=MONITOR_ONLY execution_enabled=false`;
  if (scope === "XAUUSD" || scope === "BTCUSD") {
    const b = bundles.find((x) => x.symbol === scope);
    return `${header}\nSCOPE=${scope} (hanya simbol ini; simbol lain tidak boleh dibahas sebagai data live)\n${b ? JSON.stringify(summarizeBundle(b)) : `${scope}: NO_DATA`}`;
  }
  if (scope === "ENGINE") {
    return `${header}\nSCOPE=ENGINE_HOST\n${JSON.stringify(bundles.map((b) => ({ symbol: b.symbol, health: b.health, radar_status: b.radar.health?.status ?? null, last_m5_close: iso(b.last_m5_close) })))}`;
  }
  return `${header}\nSCOPE=KNOWLEDGE (data live per simbol dipisah, jangan dicampur)\n${bundles.map((b) => `### ${b.symbol}\n${JSON.stringify(summarizeBundle(b))}`).join("\n")}`;
}
