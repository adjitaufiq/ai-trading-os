// LLM Gateway (server-only). Selects a provider adapter by env; no provider is hardcoded in the chat handler.
// LLM_PROVIDER = "openrouter" | "lovable" (default: openrouter when OPENROUTER_API_KEY is set, else lovable).
import { createOpenAI } from "@ai-sdk/openai";
import type { LlmProviderAdapter, LlmProviderId } from "../contracts";
import { createLovableAiGatewayRunIdFetch, getLovableAiGatewayRunId } from "../gateway.server";

const lovableAdapter: LlmProviderAdapter = {
  id: "lovable",
  isConfigured: () => !!process.env["LOVABLE_API_KEY"],
  create(request) {
    const apiKey = process.env["LOVABLE_API_KEY"]!;
    const modelId = "openai/gpt-6-astra";
    const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
    const p = createOpenAI({
      baseURL: "https://ai.gateway.lovable.dev/v1", apiKey,
      headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" }, fetch: runIdFetch.fetch,
    });
    return {
      provider: "lovable", modelId, model: p.responses(modelId),
      providerOptions: { openai: { forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", store: false, include: ["reasoning.encrypted_content"] } },
      getRunId: runIdFetch.getRunId, waitForRunId: runIdFetch.waitForRunId,
    };
  },
};

const openRouterAdapter: LlmProviderAdapter = {
  id: "openrouter",
  isConfigured: () => !!process.env["OPENROUTER_API_KEY"],
  create() {
    const modelId = process.env["OPENROUTER_MODEL"]?.trim() || "openrouter/free";
    const p = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1", apiKey: process.env["OPENROUTER_API_KEY"]!,
      headers: { "X-Title": "Personal AI Trading OS" },
    });
    return { provider: "openrouter", modelId, model: p.chat(modelId) };
  },
};

// Future adapters (claude / gpt / local) register here with the same contract.
const ADAPTERS: Partial<Record<LlmProviderId, LlmProviderAdapter>> = { lovable: lovableAdapter, openrouter: openRouterAdapter };

export function selectLlmAdapter(): LlmProviderAdapter | null {
  const wanted = process.env["LLM_PROVIDER"]?.trim() as LlmProviderId | undefined;
  if (wanted) { const a = ADAPTERS[wanted]; return a?.isConfigured() ? a : null; }
  if (openRouterAdapter.isConfigured()) return openRouterAdapter;
  return lovableAdapter.isConfigured() ? lovableAdapter : null;
}
