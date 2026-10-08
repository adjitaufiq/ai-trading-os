<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Frontend, including Trader Radar, is a projection-only mapper of existing runtime/engine fields: it never calculates indicators, infers direction, creates signals, changes enums, or overrides execution; strategy and authority stay outside UI. Why: Evidence ≠ Decision, AI ≠ Authority.
- Stage 10 DEMO: orders exist only on the VPS for a whitelisted demo account (see src/core/execution/demo/AGENTS.md); frontend has no order code. Why: real-account capability stays absent.
- Core engine reads time only via CanonicalClock (LiveClock or ReplayClock); Date.now() appears only inside LiveClock. Why: LIVE and REPLAY must produce identical state for identical events.
- Bars are built by CandleAggregator from event_at; lifecycle timestamps (closed_at, available_at) come from the clock, and consumers declare a TemporalPolicy. Why: prevents future-evidence leakage.
- Broker data flows RawBrokerEvent → BrokerNormalizer → AnomalyClassifier (feed quality only, no timeframe/candle lifecycle) → BrokerFeedPipeline route; only LIVE_MUTATION (STREAM delivery + ACCEPT/ACCEPT_WITH_FLAG) reaches the live sink, which is a LiveCandleFanout of independent M5/M15/H1/H4 CandleAggregators; BACKFILL goes to BACKFILL_HISTORY, RECONCILE to RECONCILIATION_CANDIDATE, both never mutate live state. Why: BACKFILL/RECONCILE must not masquerade as live evidence, and CLOSED candles stay immutable.
- Broker/internal candle comparison returns a DiscrepancyResult outcome with point metrics against a configurable tolerance, never a boolean. Why: TRS-03 needs analysable deltas, not assumed Exness values.
- The MT5 bridge (src/core/broker/bridge) exposes only whitelisted SYSTEM/DISCOVERY/MARKET_DATA capabilities through typed methods; generic invoke() is SYSTEM-only. Why: no generic bypass to an execution or untyped surface.
- Scoped rules live in vps/, src/probe/, src/core/technical/, src/core/broker/identity/, src/core/broker/gateway/, src/core/enginehost/, src/core/candles/, src/lib/assistant/, src/lib/memory/, src/lib/review/, src/core/execution/demo/, src/core/execution/control/ and src/core/broker/audit/ AGENTS.md files. Why: directory-scoped.
- The app reaches the gateway only through BrokerGatewayClient (src/core/broker/gateway): typed per-route methods, strict envelope validation, and ticks enter BrokerFeedPipeline via GatewayMarketIngest, never CandleAggregator directly. Why: unvalidated or unclassified broker data must never become evidence.
- The primary terminal (`/`) shows only validated, symbol-keyed REAL broker observations via BrokerGatewayClient; quote polling is separate from BACKFILL bar viewing and never ingests evidence. Why: read-only market viewing must not misrepresent mocks, cross-symbol responses, or historical data as live mutations.
- History→live bootstrap runs through BootstrapCoordinator (src/core/broker/bootstrap): LIVE is buffered during bootstrap, history stays BACKFILL, only LIVE_MUTATION moves LiveAcceptedFrontier, and failure or unresolved handoff uncertainty ends in DEGRADED, never SYNCHRONIZED. Why: PRE-2D R4, request completion ≠ market synchronization.
- Production code never imports src/probe/**. Why: probe ≠ Stage 4.
- Stage 3 chain is composed only in MarketRuntime (src/core/runtime); consumers get the frozen MarketRuntimeReader and tests swap only the gateway transport, never the middle components. Why: D2 — one canonical runtime, React never owns market-state transitions.
- Technical warmup uses broker /v1/bars CLOSED history seeded via MarketRuntime.seedBrokerHistory (separate BACKFILL store, never CandleStore/live fanout); TechnicalSliceService merges it with canonical CLOSED bars newer than the last history bar and drops partial pre-first-live bars. Why: real indicators without letting BACKFILL masquerade as live or forming bars repaint signals.
- Paper trading and journal (src/lib/paperJournal.ts) are local SIMULATION only, persisted in localStorage, with no broker/gateway import. Why: user research must never create an order path.
- AI Assistant uses AI Context Builder (src/lib/assistant/contextBuilder.ts, pure field copy of Engine Host bundles into AiContextPayload) and an env-selected LLM Gateway adapter (src/lib/assistant/llm/gateway.server.ts, LLM_PROVIDER / OPENROUTER_API_KEY, Lovable AI fallback). Why: Engine Host stays source of truth, provider stays swappable, LLM only explains.
- vite.config.ts aliases @vercel/oidc to its fs-free browser build. Why: its Node build makes the Worker bundle call createRequire(import.meta.url) at startup, which 500s every request.
- Assistant has separate chat/control/research routes. Why: keep chat clear.
