import { z } from "zod";

const timeframe = z.enum(["M5", "M15", "H1", "H4"]);
const zone = z.object({
  type: z.enum(["SUPPORT", "RESISTANCE"]),
  low: z.number().finite().positive(),
  high: z.number().finite().positive(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  timeframe: timeframe.optional(),
}).refine((value) => value.low <= value.high, "Invalid zone range");
const response = z.object({
  symbol: z.string().min(1).max(32),
  timeframe,
  zones: z.array(zone).max(200),
});

export type SnrZone = Readonly<z.infer<typeof zone> & { timeframe: z.infer<typeof timeframe> }>;
export type SnrSnapshot = Readonly<{
  symbol: string;
  timeframe: z.infer<typeof timeframe>;
  zones: readonly SnrZone[];
  strength: null;
  strength_status: "RESEARCH_REQUIRED";
  volume_score_status: "RESEARCH_REQUIRED";
}>;

/** Validate and copy host ranges only. Scores are deliberately discarded, never interpreted. */
export function parseSnrSnapshot(input: unknown, symbol: string): SnrSnapshot | null {
  const parsed = response.safeParse(input);
  if (!parsed.success || parsed.data.symbol !== symbol) return null;
  return Object.freeze({
    symbol: parsed.data.symbol,
    timeframe: parsed.data.timeframe,
    zones: Object.freeze(parsed.data.zones.filter((item) => item.status === "ACTIVE")
      .map((item) => Object.freeze({ ...item, timeframe: item.timeframe ?? parsed.data.timeframe }))),
    strength: null,
    strength_status: "RESEARCH_REQUIRED",
    volume_score_status: "RESEARCH_REQUIRED",
  });
}