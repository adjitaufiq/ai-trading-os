// AI Context Builder (pure). Copies Engine Host fields into AiContextPayload — no indicator math, no inference.
import type { EngineSymbolBundle } from "@/core/enginehost/types";
import { AI_CONTEXT_SCHEMA_VERSION, type AiContextPayload } from "./contracts";

const iso = (ms: number | null | undefined) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);

export function buildAiContextPayload(b: EngineSymbolBundle): AiContextPayload {
  const s = b.radar.snapshot;
  const i = s?.intelligence;
  return {
    schema: AI_CONTEXT_SCHEMA_VERSION,
    source: "ENGINE_HOST",
    symbol: b.symbol,
    timestamp: iso(b.timestamp),
    current_price: b.live ? { bid: b.live.bid, ask: b.live.ask, at: iso(b.live.event_at) } : null,
    engine_state: b.health?.state ?? null,
    radar_status: b.health?.radar_status ?? b.radar.health?.status ?? null,
    regime: s?.regime.type ?? null,
    regime_evidence: s ? s.regime.evidence.slice(0, 6) : [],
    horizon: s ? [...s.horizon.compatibleHorizons] : [],
    approach: s?.horizon.marketApproach ?? null,
    horizon_veto: s?.horizon.vetoReason ?? null,
    active_events: s ? s.activeEvents.map((e) => ({ type: e.type, severity: e.severity, timeframe: e.timeframe, age_bars: e.ageBars })) : [],
    footprint_tags: s ? [...s.footprints.activeTags] : [],
    timeframes: { h4: i?.h4_state ?? null, h1: i?.h1_state ?? null, m15: i?.m15_condition ?? null, m5: i?.m5_condition ?? null },
    bias: i?.bias ?? null,
    market_phase: i?.market_phase ?? null,
    confidence: i?.confidence ?? null,
    setup: i?.setup ?? null,
    decision: i?.status ?? null,
    risk: i?.risk_assessment ?? null,
    key_levels: i?.key_levels ?? {},
    confirmation_needed: i ? [...i.confirmation_needed] : [],
    invalidation: i ? [...i.invalidation_conditions] : [],
    reasons: i ? [...(i.reasons ?? i.audit_trail)].slice(0, 10) : [],
    operating_mode: "MONITOR_ONLY",
    execution_enabled: false,
  };
}
