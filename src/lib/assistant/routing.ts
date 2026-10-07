// Phase 4C — Task-Based LLM Routing. Pure, deterministic intent classifier.
// Engine Host stays source of truth; routing only picks HOW MUCH reasoning the explainer gets,
// never what it may say. No network, no Date.now — fully testable.

export type LlmIntent = "QUICK_EXPLAIN" | "STANDARD" | "DEEP_ANALYSIS";
export type LlmTaskTier = "fast" | "medium" | "reasoning";

const DEEP_PATTERNS: readonly RegExp[] = [
  /\bbriefing\b/i,
  /\bjournal\b/i, /\bjurnal\b/i,
  /\bperforma\b/i, /\bperformance\b/i,
  /\bbandingkan\b/i, /\bcompare\b/i, /\bperbandingan\b/i,
  /\bautopsy\b/i, /\bautopsi\b/i,
  /\bevaluasi\b/i, /\bevaluate\b/i, /\breview\b/i,
  /\bstatistik\b/i, /\bstatistics?\b/i,
  /\bsimilar\b/i, /\bmirip\b/i, /\bserupa\b/i,
  /\bhistori\b/i, /\bhistory\b/i, /\bhistorical\b/i, /\bmasa lalu\b/i,
  /\bfailure\b/i, /\bkegagalan\b/i, /\bpola\b/i, /\bpattern\b/i,
  /\bkelemahan\b/i, /\bweakness\b/i, /\bpaling (sulit|susah|konsisten|buruk|bagus)\b/i, /\bkonsisten\b/i, /\bregime apa\b/i, /\bsetup (mana|apa)\b/i,
  /\bwin rate\b/i, /\baverage r\b/i, /\br multiple\b/i,
  /\bkenapa\b.*\b(engine|decision|keputusan)\b/i,
  /\bwhy\b.*\b(engine|decision)\b/i,
];

const QUICK_PATTERNS: readonly RegExp[] = [
  /^\s*(apa|apakah|what|what's|whats)\b.{0,80}\??\s*$/i,
  /\bapa itu\b/i, /\bwhat is\b/i, /\bwhat does\b/i,
  /\barti(nya)?\b/i, /\bmaksud(nya)?\b/i, /\bmeaning\b/i,
  /\bdefinisi\b/i, /\bdefinition\b/i, /\bjelaskan istilah\b/i,
  /\bbedanya\b/i, /\bdifference between\b/i,
];

/** Classify the user's latest message into a routing intent. Briefing requests are always DEEP_ANALYSIS. */
export function classifyIntent(text: string, opts?: { readonly briefing?: boolean }): LlmIntent {
  const t = text.trim();
  if (!t) return "STANDARD";
  if (opts?.briefing) return "DEEP_ANALYSIS";
  if (DEEP_PATTERNS.some((p) => p.test(t))) return "DEEP_ANALYSIS";
  // Short definitional/FAQ questions stay cheap; long or multi-part questions need more reasoning.
  if (t.length <= 120 && QUICK_PATTERNS.some((p) => p.test(t))) return "QUICK_EXPLAIN";
  return "STANDARD";
}

export function tierForIntent(intent: LlmIntent): LlmTaskTier {
  switch (intent) {
    case "QUICK_EXPLAIN": return "fast";
    case "DEEP_ANALYSIS": return "reasoning";
    default: return "medium";
  }
}
