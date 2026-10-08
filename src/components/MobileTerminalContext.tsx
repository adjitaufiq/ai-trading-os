import { createContext, useContext, useState, type ReactNode } from "react";
import type { TradingSnapshot } from "@/core/technical/tradingState";
import type { RuntimeFacts } from "@/lib/cockpitSource";
export type MobileTab = "TRADE" | "RADAR" | "ANALYSIS";
export interface MobileObservation { symbol: string; bid: string; ask: string; spread: string; connected: boolean; fresh: boolean; detail: string }
interface MobileState { tab: MobileTab; setTab: (tab: MobileTab) => void; observation: MobileObservation | null; setObservation: (v: MobileObservation) => void; report: { snapshot: TradingSnapshot | null; facts: RuntimeFacts } | null; setReport: (v: { snapshot: TradingSnapshot | null; facts: RuntimeFacts } | null) => void; accessory: string | null; setAccessory: (v: string | null) => void }
const Context = createContext<MobileState | null>(null);
export function MobileTerminalProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<MobileTab>("TRADE");
  const [observation, setObservation] = useState<MobileObservation | null>(null);
  const [report, setReport] = useState<MobileState["report"]>(null);
  const [accessory, setAccessory] = useState<string | null>(null);
  return <Context.Provider value={{ tab, setTab, observation, setObservation, report, setReport, accessory, setAccessory }}>{children}</Context.Provider>;
}
export const useMobileTerminal = () => useContext(Context);
