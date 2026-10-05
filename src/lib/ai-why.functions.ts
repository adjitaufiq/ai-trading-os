// Async read-only AI WHY analyst. AI ≠ AUTHORITY: it receives a frozen deterministic snapshot and returns text only.
// Its output is never fed back into any state machine.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type AiWhyResult = { status: "OK"; narrative: string; model: string } | { status: "AI_ANALYST_UNAVAILABLE"; reason: string };

export const explainTradingState = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ snapshot: z.string().max(20_000) }).parse(d))
  .handler(async ({ data }): Promise<AiWhyResult> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) return { status: "AI_ANALYST_UNAVAILABLE", reason: "No AI provider configured" };
    const model = "openai/gpt-6-astra";
    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
        method: "POST",
        headers: { "Lovable-API-Key": key, "Content-Type": "application/json", "X-Lovable-AIG-SDK": "fetch" },
        body: JSON.stringify({
          model, store: false, reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"],
          instructions: "You explain a deterministic trading-state snapshot in plain language. You have NO authority. Use only values present in the JSON; never invent indicator values, levels, or patterns; never recommend placing an order. Explain bias, setup, signal, execution reasons, and conflicts in under 150 words.",
          input: data.snapshot,
        }),
      });
      if (!res.ok) return { status: "AI_ANALYST_UNAVAILABLE", reason: `AI gateway HTTP ${res.status}` };
      const j = (await res.json()) as { output_text?: string; output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
      const narrative = j.output_text ?? j.output?.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("");
      return typeof narrative === "string" && narrative.length > 0 ? { status: "OK", narrative, model } : { status: "AI_ANALYST_UNAVAILABLE", reason: "Invalid AI output" };
    } catch (e) {
      return { status: "AI_ANALYST_UNAVAILABLE", reason: (e as Error).message };
    }
  });
