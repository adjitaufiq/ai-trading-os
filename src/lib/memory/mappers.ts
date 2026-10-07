// Phase 4A Trading Memory (pure). Copies Engine Host fields into storage rows — no calculation, no inference.
// AI may compare these rows; it may never modify trading rules.
import type { EngineSymbolBundle } from "@/core/enginehost/types";
import type { JournalTrade } from "@/engine/journal/types";
import type { DemoTradeRecord } from "@/core/execution/demo/types";

const iso = (ms: number) => new Date(ms).toISOString();

export interface MemoryRow {
  symbol: string; m5_close_at: string; engine_state: string | null; radar_status: string | null; data_source: string | null;
  regime: string | null; horizon: string[]; approach: string | null; bias: string | null; market_phase: string | null;
  h4_state: string | null; h1_state: string | null; setup: string | null; decision: string | null; confidence: number | null;
  risk: string | null; support: number | null; resistance: number | null; price: number | null;
  invalidation: string[]; confirmation_needed: string[]; reasons: string[]; active_events: string[];
}

/** null = nothing to record (no closed M5 yet or radar not ready). Keyed by (symbol, m5_close_at) ⇒ one row per closed bar. */
export function bundleToMemoryRow(b: EngineSymbolBundle): MemoryRow | null {
  const s = b.radar.snapshot;
  if (!s || typeof b.last_m5_close !== "number" || b.last_m5_close <= 0) return null;
  const i = s.intelligence;
  return {
    symbol: b.symbol, m5_close_at: iso(b.last_m5_close),
    engine_state: b.health?.state ?? null, radar_status: b.health?.radar_status ?? b.radar.health?.status ?? null,
    data_source: s.validationSource?.dataSource ?? null,
    regime: s.regime.type ?? null, horizon: [...s.horizon.compatibleHorizons], approach: s.horizon.marketApproach ?? null,
    bias: i?.bias ?? null, market_phase: i?.market_phase ?? null, h4_state: i?.h4_state ?? null, h1_state: i?.h1_state ?? null,
    setup: i?.setup ?? null, decision: i?.status ?? null, confidence: i?.confidence ?? null, risk: i?.risk_assessment ?? null,
    support: i?.key_levels?.support ?? null, resistance: i?.key_levels?.resistance ?? null,
    price: b.live ? (b.live.bid + b.live.ask) / 2 : null,
    invalidation: i ? [...i.invalidation_conditions] : [], confirmation_needed: i ? [...i.confirmation_needed] : [],
    reasons: i ? [...(i.reasons ?? i.audit_trail)].slice(0, 12) : [],
    active_events: s.activeEvents.map((e) => `${e.type}:${e.severity}`),
  };
}

export interface TradeRow {
  trade_id: string; symbol: string; direction: string; result: string; close_reason: string | null;
  opened_at: string; closed_at: string; profit_loss_usd: number; risk_usd: number; r_multiple: number | null;
  failure_category: string | null; data_source: string | null; regime: string | null; approach: string | null;
  location: string | null; trigger_pattern: string | null; reaction_quality: string | null; payload: unknown;
}

export function tradeToRow(t: JournalTrade): TradeRow {
  return {
    trade_id: t.tradeId, symbol: t.symbol, direction: t.direction, result: t.result, close_reason: t.closeReason ?? null,
    opened_at: iso(t.openedAt), closed_at: iso(t.closedAt), profit_loss_usd: t.profitLossUSD, risk_usd: t.riskUSD,
    r_multiple: t.riskUSD > 0 ? Math.round((t.profitLossUSD / t.riskUSD) * 10000) / 10000 : null,
    failure_category: t.primaryFailureCategory ?? null, data_source: t.dataSource ?? null,
    regime: t.contextSnapshot?.regime ?? null, approach: t.contextSnapshot?.marketApproach ?? null,
    location: t.context?.priceLocation ?? null, trigger_pattern: t.context?.triggerPattern ?? null,
    reaction_quality: t.context?.reactionQuality ?? null, payload: t,
  };
}

/** Stage 10 demo lab: one engine_trades row per CLOSED demo order (data_source DEMO_MT5, never mixed with paper). */
export function demoRecordToRow(r: DemoTradeRecord): TradeRow | null {
  if (r.executionResult !== "FILLED" || r.closedAt === null || r.profitLossUSD === null || r.outcome === null) return null;
  return {
    trade_id: r.tradeId, symbol: r.symbol, direction: r.direction, result: r.outcome, close_reason: r.exitReason === "SL" ? "SL_HIT" : r.exitReason === "TP" ? "TP_HIT" : "OTHER",
    opened_at: iso(r.sentAt), closed_at: iso(r.closedAt), profit_loss_usd: r.profitLossUSD, risk_usd: r.riskUSD,
    r_multiple: r.riskUSD > 0 ? Math.round((r.profitLossUSD / r.riskUSD) * 10000) / 10000 : null,
    failure_category: null, data_source: "DEMO_MT5", regime: r.context.regime, approach: null,
    location: r.context.signalSource["location"] ?? null, trigger_pattern: r.context.signalSource["trigger"] ?? null,
    reaction_quality: r.context.signalSource["reactionQuality"] ?? null,
    payload: { ...r, tradingStyle: tradingStyleOf(r.sentAt, r.closedAt), durationSeconds: Math.round((r.closedAt - r.sentAt) / 1000) } as unknown as typeof r,
  };
}
