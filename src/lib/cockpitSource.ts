// One cockpit source per view (Phase 2.1). A source is EITHER the engine host (VPS) OR the browser session —
// every fact a card renders comes from the same source object, tagged with { source, symbol, timestamp }.
import type { MarketRuntimeReader } from "@/core/runtime/MarketRuntime";
import type { TechnicalSliceService, SliceView } from "@/core/technical/TechnicalSliceService";
import type { RadarHealth, RadarSnapshot } from "@/core/radar/types";
import type { VirtualAccountView } from "@/core/paper/LivePaperLoop";
import type { EngineSymbolBundle, LiveQuoteFacts, SymbolEngineHealth, UiDataSource } from "@/core/enginehost/types";
import type { JournalTrade } from "@/engine/journal/types";

export interface RuntimeFacts {
  readonly source: UiDataSource;
  readonly symbol: string;
  readonly timestamp: number | null;
  readonly radar: Readonly<RadarSnapshot> | null;
  readonly radarHealth: Readonly<RadarHealth> | null;
  readonly live: LiveQuoteFacts | null;
  readonly lastM5Close: number | null;
  readonly account: Readonly<VirtualAccountView> | null;
  readonly trades: readonly Readonly<JournalTrade>[];
  readonly engineHealth: SymbolEngineHealth | null;
}

export interface CockpitSource {
  readonly symbol: string;
  readonly source: UiDataSource;
  subscribe(l: () => void): () => void;
  getVersion(): number;
  view(): SliceView | null;
  facts(): RuntimeFacts;
}

export function localCockpitSource(service: TechnicalSliceService, reader: MarketRuntimeReader): CockpitSource {
  return {
    symbol: service.symbol, source: "BROWSER_SESSION",
    subscribe: service.subscribe, getVersion: service.getVersion,
    view: () => service.view(),
    facts: () => {
      const live = reader.latestLiveObservation();
      return {
        source: "BROWSER_SESSION", symbol: reader.symbol, timestamp: reader.now(),
        radar: reader.radarSnapshot?.() ?? null, radarHealth: reader.radarHealth?.() ?? null,
        live: live ? { source: live.source, bid: live.bid, ask: live.ask, event_at: live.event_at, observed_at: live.observed_at } : null,
        lastM5Close: reader.closedBars("M5").at(-1)?.close_time ?? null,
        account: reader.paperAccount?.() ?? null, trades: reader.paperTrades?.() ?? [], engineHealth: null,
      };
    },
  };
}

export function bundleFacts(b: EngineSymbolBundle): RuntimeFacts {
  return {
    source: b.source, symbol: b.symbol, timestamp: b.timestamp,
    radar: b.radar.snapshot, radarHealth: b.radar.health, live: b.live, lastM5Close: b.last_m5_close,
    account: b.account, trades: b.trades, engineHealth: b.health,
  };
}

/** Engine-host source backed by the attach store; re-render is driven by the store version only. */
export function remoteCockpitSource(symbol: string, store: { subscribe(l: () => void): () => void; getVersion(): number; getState(): { bundles: Readonly<Record<string, EngineSymbolBundle>> } }): CockpitSource {
  const bundle = () => store.getState().bundles[symbol] ?? null;
  return {
    symbol, source: "ENGINE_HOST",
    subscribe: store.subscribe, getVersion: store.getVersion,
    view: () => bundle()?.slice ?? null,
    facts: () => {
      const b = bundle();
      return b ? bundleFacts(b) : { source: "ENGINE_HOST", symbol, timestamp: null, radar: null, radarHealth: null, live: null, lastM5Close: null, account: null, trades: [], engineHealth: null };
    },
  };
}
