// Canonical data-source tag. Every journal row and radar snapshot carries one so statistics never mix sources.
export type DataSource = "REAL_MT5" | "SYNTHETIC" | "BACKTEST";
export const DATA_SOURCES: readonly DataSource[] = ["REAL_MT5", "SYNTHETIC", "BACKTEST"];
