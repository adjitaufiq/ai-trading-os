import type { BridgeBar } from "@/core/broker/gateway/types";
export type ChartRange = { from: number; to: number };
/** Preserve the same candle anchor when rolling history shifts logical indices. */
export function preserveChartRange(range: ChartRange, previous: readonly BridgeBar[], next: readonly BridgeBar[]): ChartRange {
  const positions = new Map(next.map((bar, i) => [bar.raw_time_s, i]));
  const anchor = previous.findIndex((bar) => positions.has(bar.raw_time_s));
  const time = previous[anchor]?.raw_time_s;
  const position = time == null ? undefined : positions.get(time);
  if (position == null) return range;
  const shift = position - anchor;
  return { from: range.from + shift, to: range.to + shift };
}
/** Explicit zoom anchors recent candles; native wheel/pinch retain SDK cursor anchoring. */
export function zoomChartRange(range: ChartRange, count: number, direction: "in" | "out"): ChartRange {
  const span = Math.max(8, Math.min(Math.max(8, count + 16), (range.to - range.from) * (direction === "in" ? 0.7 : 1 / 0.7)));
  const to = count - 1 + Math.min(8, span * 0.1);
  return { from: to - span, to };
}