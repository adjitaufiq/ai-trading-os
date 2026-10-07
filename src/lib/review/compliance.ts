// Phase 5A — Rule Compliance Review (pure, deterministic). Compares a CLOSED paper trade with the
// Engine Host state recorded in Trading Memory at open. Descriptive only: never changes rules, never signals.
export const TRADE_REVIEW_VERSION = "trade-review-v1";
/** Engine's own READY threshold (MTF policy). Mirrored for audit only; never tuned here. */
export const READY_CONFIDENCE = 75;
/** Memory row must be at most this old at entry to count as "state at open". */
export const STATE_MAX_AGE_MIN = 15;

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "NOT_EVALUABLE";
export type ComplianceStatus = "COMPLIANT" | "COMPLIANT_WITH_NOTES" | "NON_COMPLIANT" | "NOT_EVALUABLE";

export interface ReviewTrade {
  trade_id: string; symbol: string; direction: string; result: string; close_reason: string | null;
  opened_at: string; closed_at: string; profit_loss_usd: number; risk_usd: number; r_multiple: number | null;
  failure_category: string | null; data_source: string | null; regime: string | null; approach: string | null;
  location: string | null; trigger_pattern: string | null; reaction_quality: string | null;
  payload: { entryPrice?: number; stopLoss?: number; takeProfit?: number; exitPrice?: number; durationSeconds?: number;
    excursion?: { mfeR?: number; maeR?: number } | null; decisionTrace?: string[] } | null;
}
export interface ReviewState {
  m5_close_at: string; regime: string | null; approach: string | null; bias: string | null; market_phase: string | null;
  h4_state: string | null; h1_state: string | null; setup: string | null; decision: string | null; confidence: number | null;
  risk: string | null; support: number | null; resistance: number | null; reasons: string[]; invalidation: string[];
}
export interface Check { id: string; status: CheckStatus; detail: string }

/** Latest memory row at or before `atIso` within STATE_MAX_AGE_MIN; rows may be in any order. */
export function stateAt(rows: readonly ReviewState[], atIso: string): ReviewState | null {
  const t = Date.parse(atIso);
  let best: ReviewState | null = null;
  for (const r of rows) {
    const rt = Date.parse(r.m5_close_at);
    if (rt <= t && t - rt <= STATE_MAX_AGE_MIN * 60_000 && (!best || rt > Date.parse(best.m5_close_at))) best = r;
  }
  return best;
}

export function complianceChecks(trade: ReviewTrade, atOpen: ReviewState | null): Check[] {
  const p = trade.payload ?? {};
  const checks: Check[] = [];
  if (!atOpen) {
    checks.push({ id: "STATE_AT_OPEN", status: "NOT_EVALUABLE", detail: `Tidak ada snapshot memory ≤${STATE_MAX_AGE_MIN} menit sebelum entry.` });
  } else {
    checks.push({ id: "STATE_AT_OPEN", status: "PASS", detail: `Snapshot M5 ${atOpen.m5_close_at}.` });
    checks.push({ id: "DECISION_READY_AT_OPEN", status: atOpen.decision === "READY" ? "PASS" : atOpen.decision ? "FAIL" : "NOT_EVALUABLE",
      detail: `Decision engine saat entry: ${atOpen.decision ?? "tidak tercatat"}.` });
    checks.push({ id: "CONFIDENCE_THRESHOLD", status: atOpen.confidence == null ? "NOT_EVALUABLE" : atOpen.confidence >= READY_CONFIDENCE ? "PASS" : "FAIL",
      detail: `Confidence ${atOpen.confidence ?? "—"} vs ambang ${READY_CONFIDENCE}.` });
    const bias = atOpen.bias ?? "";
    const aligned = (trade.direction === "BUY" && bias === "BULLISH") || (trade.direction === "SELL" && bias === "BEARISH");
    const opposed = (trade.direction === "BUY" && bias === "BEARISH") || (trade.direction === "SELL" && bias === "BULLISH");
    checks.push({ id: "DIRECTION_VS_BIAS", status: !bias ? "NOT_EVALUABLE" : aligned ? "PASS" : opposed ? "FAIL" : "WARN",
      detail: `Arah trade ${trade.direction} vs bias engine ${bias || "—"}.` });
    checks.push({ id: "REGIME_CONSISTENT", status: !trade.regime || !atOpen.regime ? "NOT_EVALUABLE" : trade.regime === atOpen.regime ? "PASS" : "WARN",
      detail: `Regime di trade ${trade.regime ?? "—"} vs memory ${atOpen.regime ?? "—"}.` });
  }
  const slOk = typeof p.entryPrice === "number" && typeof p.stopLoss === "number"
    && (trade.direction === "BUY" ? p.stopLoss < p.entryPrice : p.stopLoss > p.entryPrice);
  checks.push({ id: "RISK_DEFINED", status: slOk && trade.risk_usd > 0 ? "PASS" : "FAIL",
    detail: `Entry ${p.entryPrice ?? "—"}, SL ${p.stopLoss ?? "—"}, risk $${trade.risk_usd}.` });
  checks.push({ id: "DATA_SOURCE", status: trade.data_source === "REAL_MT5" ? "PASS" : "WARN",
    detail: `Sumber data ${trade.data_source ?? "UNKNOWN"}${trade.data_source === "REAL_MT5" ? "" : " — dipisah dari statistik REAL_MT5"}.` });
  return checks;
}

export function overallStatus(checks: readonly Check[]): ComplianceStatus {
  if (checks.some((c) => c.status === "FAIL")) return "NON_COMPLIANT";
  if (checks.some((c) => c.id === "STATE_AT_OPEN" && c.status === "NOT_EVALUABLE")) return "NOT_EVALUABLE";
  if (checks.some((c) => c.status === "WARN" || c.status === "NOT_EVALUABLE")) return "COMPLIANT_WITH_NOTES";
  return "COMPLIANT";
}

/** Copy-only facts handed to the analyst LLM. No new numbers except r_multiple already stored. */
export function reviewFacts(trade: ReviewTrade, atOpen: ReviewState | null, atClose: ReviewState | null) {
  const p = trade.payload ?? {};
  return {
    trade: { id: trade.trade_id, symbol: trade.symbol, direction: trade.direction, opened_at: trade.opened_at, closed_at: trade.closed_at,
      entry: p.entryPrice ?? null, stop_loss: p.stopLoss ?? null, take_profit: p.takeProfit ?? null, exit: p.exitPrice ?? null,
      duration_s: p.durationSeconds ?? null, result: trade.result, close_reason: trade.close_reason, r_multiple: trade.r_multiple,
      pnl_usd: trade.profit_loss_usd, failure_category: trade.failure_category, data_source: trade.data_source,
      setup: { regime: trade.regime, approach: trade.approach, location: trade.location, trigger: trade.trigger_pattern, reaction: trade.reaction_quality },
      excursion: p.excursion ?? null, decision_trace: (p.decisionTrace ?? []).slice(0, 10) },
    engine_at_open: atOpen, engine_at_close: atClose,
  };
}
