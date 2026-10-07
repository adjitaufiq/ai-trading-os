// Phase 3 contracts: AI Context Builder payload + LLM Gateway provider interface.
// Engine Host = SOURCE OF TRUTH. LLM = reasoning/explanation only; never calculates, never decides, never executes.
import type { LanguageModel } from "ai";
import type { LlmTaskTier } from "./routing";

export const AI_CONTEXT_SCHEMA_VERSION = "ai-context-v1";

export interface AiTimeframeContext {
  readonly h4: string | null;
  readonly h1: string | null;
  readonly m15: string | null;
  readonly m5: string | null;
}

/** Structured, read-only projection of one Engine Host symbol bundle. Every field is copied, never computed. */
export interface AiContextPayload {
  readonly schema: typeof AI_CONTEXT_SCHEMA_VERSION;
  readonly source: "ENGINE_HOST";
  readonly symbol: string;
  readonly timestamp: string | null;
  readonly current_price: { readonly bid: number; readonly ask: number; readonly at: string | null } | null;
  readonly engine_state: string | null;
  readonly radar_status: string | null;
  readonly regime: string | null;
  readonly regime_evidence: readonly string[];
  readonly horizon: readonly string[];
  readonly approach: string | null;
  readonly horizon_veto: string | null;
  readonly active_events: readonly { type: string; severity: string; timeframe: string | null; age_bars: number }[];
  readonly footprint_tags: readonly string[];
  readonly timeframes: AiTimeframeContext;
  readonly bias: string | null;
  readonly market_phase: string | null;
  readonly confidence: number | null;
  readonly setup: string | null;
  /** Engine decision (MTF DecisionStatus) — READY / WAIT_CONFIRMATION / STAND_ASIDE / NO_DATA. */
  readonly decision: string | null;
  readonly risk: string | null;
  readonly key_levels: { readonly support?: number; readonly resistance?: number };
  readonly confirmation_needed: readonly string[];
  readonly invalidation: readonly string[];
  readonly reasons: readonly string[];
  readonly operating_mode: "MONITOR_ONLY";
  readonly execution_enabled: false;
}

export type LlmProviderId = "lovable" | "openrouter" | "claude" | "gpt" | "local";

export interface LlmModelSelection {
  readonly provider: LlmProviderId;
  readonly modelId: string;
  readonly model: LanguageModel;
  /** Provider-specific streamText providerOptions (e.g. reasoning settings). */
  readonly providerOptions?: Record<string, Record<string, unknown>>;
  readonly getRunId?: () => string | undefined;
  readonly waitForRunId?: () => Promise<string | undefined>;
}

/** Adapter contract. Adapters only build a model handle; they never see orders or mutate engine state. */
export interface LlmProviderAdapter {
  readonly id: LlmProviderId;
  isConfigured(): boolean;
  create(request: Request, tier?: LlmTaskTier): LlmModelSelection;
}

/** Phase 4C task tier — how much reasoning the explainer gets, never what it may say. */
export type { LlmTaskTier } from "./routing";
