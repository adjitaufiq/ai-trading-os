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

- Frontend is a read-only view; strategy, guards and execution live in the external Python/FastAPI service. Why: architecture boundary (Evidence ≠ Decision, AI ≠ Authority).
- No order/execution code exists in the frontend until Stage 10 (DEMO). Why: capability must not exist, not merely be disabled.
- Core engine reads time only via CanonicalClock (LiveClock or ReplayClock); Date.now() appears only inside LiveClock. Why: LIVE and REPLAY must produce identical state for identical events.
- Bars are built by CandleAggregator from event_at; lifecycle timestamps (closed_at, available_at) come from the clock, and consumers declare a TemporalPolicy. Why: prevents future-evidence leakage.
- Broker data flows RawBrokerEvent → BrokerNormalizer → AnomalyClassifier (feed quality only, no timeframe/candle lifecycle) → BrokerFeedPipeline route; only LIVE_MUTATION (STREAM delivery + ACCEPT/ACCEPT_WITH_FLAG) reaches the live sink, which is a LiveCandleFanout of independent M5/M15/H1/H4 CandleAggregators; BACKFILL goes to BACKFILL_HISTORY, RECONCILE to RECONCILIATION_CANDIDATE, both never mutate live state. Why: BACKFILL/RECONCILE must not masquerade as live evidence, and CLOSED candles stay immutable.
- Broker/internal candle comparison returns a DiscrepancyResult outcome with point metrics against a configurable tolerance, never a boolean. Why: TRS-03 needs analysable deltas, not assumed Exness values.
- The MT5 bridge (src/core/broker/bridge) exposes only whitelisted SYSTEM/DISCOVERY/MARKET_DATA capabilities through typed methods; generic invoke() is SYSTEM-only. Why: no generic bypass to an execution or untyped surface.
- Scoped rules live in vps/, src/probe/, src/core/technical/, src/core/broker/identity/ and src/core/candles/ AGENTS.md files. Why: directory-scoped.
- The app reaches the gateway only through BrokerGatewayClient (src/core/broker/gateway): typed per-route methods, strict envelope validation, and ticks enter BrokerFeedPipeline via GatewayMarketIngest, never CandleAggregator directly. Why: unvalidated or unclassified broker data must never become evidence.
- BrokerGatewayClient receives its WebSocket constructor by injection (wsFactory); src/ never constructs a socket itself. Why: intentional DI boundary that keeps the frozen 3.0A "no WebSocket( in src" invariant and lets tests drive the stream deterministically.
- Real broker audit UI (src/components/BrokerAuditTerminal.tsx, /audit) reads only via BrokerGatewayClient and pure helpers in src/core/broker/audit; it never mutates, fills or ingests data. Why: audit surfaces discrepancies, it must not create evidence.
- The primary terminal (`/`) shows only validated, symbol-keyed REAL broker observations via BrokerGatewayClient; quote polling is separate from BACKFILL bar viewing and never ingests evidence. Why: read-only market viewing must not misrepresent mocks, cross-symbol responses, or historical data as live mutations.
- History→live bootstrap runs through BootstrapCoordinator (src/core/broker/bootstrap): LIVE is buffered during bootstrap, history stays BACKFILL, only LIVE_MUTATION moves LiveAcceptedFrontier, and failure or unresolved handoff uncertainty ends in DEGRADED, never SYNCHRONIZED. Why: PRE-2D R4, request completion ≠ market synchronization.
- Missing intervals are MissingInterval objects (src/core/candles/MissingInterval.ts) with explicit reasons, never candles; no session contract is hardcoded, so absent authority yields OUTSIDE_SESSION_CONTRACT_UNRESOLVED. Why: PRE-2D R5, uncertainty must not become fabricated OHLC or assumed broker failure.
- Production code never imports src/probe/**. Why: probe ≠ Stage 4.
- Stage 3 chain is composed only in MarketRuntime (src/core/runtime); consumers get the frozen MarketRuntimeReader and tests swap only the gateway transport, never the middle components. Why: D2 — one canonical runtime, React never owns market-state transitions.
- BrokerGatewayClient accepts the non-3.0B-1 capability "MARKET_DATA.TICK" only on LIVE /v1/stream frames (counted via streamCapabilityAliasCount); REST validation stays exact. Why: real gateway dialect, contract debt to fix on the gateway side.
- CandleAggregator skew tolerance (from ClassifierConfig.maxSourceTimeSkewMs) defers next-bucket ticks until the canonical clock reaches close_time; bars never close early. Why: source clock runs a few seconds ahead of bridge/client.
