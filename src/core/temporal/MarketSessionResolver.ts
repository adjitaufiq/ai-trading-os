// Pure, deterministic session resolver. No clock reads; caller supplies the timestamp (UTC ms).
import type { AssetClass } from "../broker/types";

export type MarketSession = "ASIA" | "LONDON" | "NY" | "OVERNIGHT" | "WEEKEND" | "MARKET_CLOSED";

export interface SessionWindow { readonly session: "ASIA" | "LONDON" | "NY" | "OVERNIGHT"; readonly fromHourUtc: number; readonly toHourUtc: number }

export interface MarketCalendarProvider {
  /** Weekday hour windows (UTC, half-open [from,to)). */
  sessions(assetClass: AssetClass): readonly SessionWindow[];
  /** True when the venue is closed (e.g. weekly close). */
  isClosed(timestampMs: number, assetClass: AssetClass): boolean;
  /** True when the timestamp falls on a 24/7 market's weekend. */
  isWeekend(timestampMs: number, assetClass: AssetClass): boolean;
}

const WINDOWS: readonly SessionWindow[] = [
  { session: "ASIA", fromHourUtc: 0, toHourUtc: 7 },
  { session: "LONDON", fromHourUtc: 7, toHourUtc: 12 },
  { session: "NY", fromHourUtc: 12, toHourUtc: 21 },
  { session: "OVERNIGHT", fromHourUtc: 21, toHourUtc: 24 },
];

/** Default calendar. Weekly close (non-crypto): Friday 21:00 UTC → Sunday 22:00 UTC. Assumption, not a broker contract. */
export const DEFAULT_MARKET_CALENDAR: MarketCalendarProvider = {
  sessions: () => WINDOWS,
  isClosed(ts, ac) {
    if (ac === "CRYPTO") return false;
    const d = new Date(ts); const day = d.getUTCDay(); const h = d.getUTCHours();
    return (day === 5 && h >= 21) || day === 6 || (day === 0 && h < 22);
  },
  isWeekend(ts, ac) {
    if (ac !== "CRYPTO") return false;
    const day = new Date(ts).getUTCDay();
    return day === 0 || day === 6;
  },
};

export function resolveMarketSession(timestampMs: number, assetClass: AssetClass, calendar: MarketCalendarProvider = DEFAULT_MARKET_CALENDAR): MarketSession {
  if (calendar.isClosed(timestampMs, assetClass)) return "MARKET_CLOSED";
  if (calendar.isWeekend(timestampMs, assetClass)) return "WEEKEND";
  const h = new Date(timestampMs).getUTCHours();
  return calendar.sessions(assetClass).find((w) => h >= w.fromHourUtc && h < w.toHourUtc)?.session ?? "OVERNIGHT";
}

/**
 * Scheduled-closure gap test (timestamps in epoch SECONDS, bar open times).
 * Expected iff the missing span [lastTs+tf, nextTs) contains a MARKET_CLOSED step and fewer than one bar of open time.
 */
export function isCalendarGap(lastTs: number, nextTs: number, tfSeconds: number, assetClass: AssetClass, calendar: MarketCalendarProvider = DEFAULT_MARKET_CALENDAR, stepSeconds = 300): boolean {
  let closed = 0, open = 0;
  for (let t = lastTs + tfSeconds; t < nextTs; t += stepSeconds) {
    if (calendar.isClosed(t * 1000, assetClass)) closed++; else open++;
  }
  return closed > 0 && open * stepSeconds < tfSeconds;
}
