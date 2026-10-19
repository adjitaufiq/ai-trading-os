import type { TechBar } from "@/core/technical/indicators";

/** Parses the real gateway MARKET_DATA.BARS envelope ({ data: { items: [{ raw_time_s, open, high, low, close }] } }).
 * Any malformed row ⇒ null (whole response refused, no partial history). */
export function parseGatewayBars(e: unknown, tfMs: number): TechBar[] | null {
  const items = (e as { data?: { items?: unknown } } | null)?.data?.items;
  if (!Array.isArray(items)) return null;
  const out: TechBar[] = [];
  for (const b of items as Record<string, unknown>[]) {
    const t = b?.raw_time_s, o = b?.open, h = b?.high, l = b?.low, c = b?.close;
    if (![t, o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x)) || (t as number) <= 0) return null;
    const ms = (t as number) * 1000;
    out.push({ open_time: ms, close_time: ms + tfMs, available_at: ms + tfMs, open: o as number, high: h as number, low: l as number, close: c as number });
  }
  return out.sort((a, b) => a.open_time - b.open_time);
}
