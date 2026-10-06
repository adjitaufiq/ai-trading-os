import type { JournalTrade } from "./types";

const CSV_HEADER = ["Date", "Symbol", "Direction", "Location", "Trigger", "Entry", "SL", "TP", "Result", "PnL", "Reason"];

const esc = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportJournal(trades: readonly JournalTrade[], format: "JSON" | "CSV"): string {
  if (format === "JSON") return JSON.stringify(trades, null, 2);
  const rows = trades.map((t) => [
    new Date(t.closedAt * 1000).toISOString(), t.symbol, t.direction, t.context.priceLocation, t.context.triggerPattern,
    t.entryPrice, t.stopLoss, t.takeProfit, t.result, t.profitLossUSD, t.closeReason,
  ].map(esc).join(","));
  return [CSV_HEADER.join(","), ...rows].join("\n");
}
