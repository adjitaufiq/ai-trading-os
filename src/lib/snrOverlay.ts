import { z } from "zod";

const timeframe = z.enum(["M5", "M15", "H1", "H4"]);
const zone = z.object({
  type: z.enum(["SUPPORT", "RESISTANCE"]),
  low: z.number().finite().positive(),
  high: z.number().finite().positive(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  timeframe: timeframe.optional(),
}).refine((value) => value.low <= value.high, "Invalid zone range");
const swing = z.object({
  kind: z.enum(["HIGH", "LOW"]), price: z.number().finite().positive(),
  timeframe: z.enum(["H4", "H1", "M15"]),
  pivot_time: z.number().finite().nonnegative(), confirmed_at: z.number().finite().nonnegative(),
  available_at: z.number().finite().nonnegative(),
}).refine((s) => s.confirmed_at > s.pivot_time && s.available_at >= s.confirmed_at, "Unconfirmed swing");
const response = z.object({
  symbol: z.string().min(1).max(32),
  timeframe,
  zones: z.array(zone).max(200),
  as_of: z.number().finite().nonnegative().optional(),
  price: z.number().finite().positive().optional(),
  swings: z.array(swing).max(100).optional(),
});

export type SnrZone = Readonly<z.infer<typeof zone> & { timeframe: z.infer<typeof timeframe> }>;
export type SnrSwing = Readonly<z.infer<typeof swing>>;
export type SnrSnapshot = Readonly<{
  symbol: string;
  timeframe: z.infer<typeof timeframe>;
  zones: readonly SnrZone[];
  swings: readonly SnrSwing[];
  price: number | null;
  as_of: number | null;
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
    price: parsed.data.price ?? null,
    as_of: parsed.data.as_of ?? null,
    swings: Object.freeze((parsed.data.swings ?? []).filter((s) => parsed.data.as_of != null && s.confirmed_at <= parsed.data.as_of && s.available_at <= parsed.data.as_of).map((s) => Object.freeze(s))),
    strength: null,
    strength_status: "RESEARCH_REQUIRED",
    volume_score_status: "RESEARCH_REQUIRED",
  });
}

const STRUCTURE_TFS = ["H4", "H1", "M15"] as const;
/** Display selection only: retains exact host ranges/roles. Never ranks strength or derives a level. */
export function selectSnrZones(snapshot: SnrSnapshot | null, currentPrice: number | null, chartTimeframe: string = "M5"): readonly SnrZone[] {
  const price = currentPrice ?? snapshot?.price;
  if (!snapshot || price == null || !Number.isFinite(price) || price <= 0) return [];
  const distance = (z: SnrZone) => price < z.low ? z.low - price : price > z.high ? price - z.high : 0;
  const tfs = chartTimeframe === "H4" ? STRUCTURE_TFS.slice(0, 1) : chartTimeframe === "H1" ? STRUCTURE_TFS.slice(0, 2) : STRUCTURE_TFS;
  const caps = { H4: 4, H1: 3, M15: 1 } as const;
  return Object.freeze(tfs.flatMap((tf) => {
    const seen = new Set<string>();
    const counts = { SUPPORT: 0, RESISTANCE: 0 };
    return snapshot.zones.filter((z) => z.status === "ACTIVE" && z.timeframe === tf)
      .sort((a, b) => distance(a) - distance(b) || a.low - b.low || a.high - b.high || a.type.localeCompare(b.type))
      .filter((z) => {
        const key = `${z.type}:${z.low}:${z.high}`;
        if (seen.has(key) || (tf === "H4" && counts[z.type] >= 2)) return false;
        seen.add(key); counts[z.type] += 1;
        return true;
      }).slice(0, caps[tf]);
  }));
}

export function snrZoneLabel(zone: SnrZone, digits: number | null): string {
  const format = (value: number) => digits == null ? String(value) : value.toFixed(digits);
  return `${zone.type === "SUPPORT" ? "DEMAND" : "SUPPLY"} ZONE ${zone.timeframe} ${format(zone.low)} - ${format(zone.high)}`;
}
