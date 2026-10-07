// Descriptive trading-style label derived only from actual holding time of a closed trade. Never feeds decisions.
export type TradingStyle = "SCALPING" | "INTRADAY" | "SWING";

export function tradingStyleOf(openedAtMs: number, closedAtMs: number): TradingStyle {
  const h = (closedAtMs - openedAtMs) / 3_600_000;
  return h < 1 ? "SCALPING" : h < 24 ? "INTRADAY" : "SWING";
}
