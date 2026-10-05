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
- Market data enters via a MarketAdapter interface (mock now, API-backed later). Why: swap broker source without touching UI.
- Core engine reads time only via CanonicalClock (LiveClock or ReplayClock); Date.now() appears only inside LiveClock. Why: LIVE and REPLAY must produce identical state for identical events.
- Bars are built by CandleAggregator from event_at; lifecycle timestamps (closed_at, available_at) come from the clock, and consumers declare a TemporalPolicy. Why: prevents future-evidence leakage.
- Broker data flows RawBrokerEvent → BrokerNormalizer → AnomalyClassifier (feed quality only, no timeframe/candle lifecycle) → BrokerFeedPipeline route; only LIVE_MUTATION (STREAM delivery + ACCEPT/ACCEPT_WITH_FLAG) reaches the live sink, which is a LiveCandleFanout of independent M5/M15/H1/H4 CandleAggregators; BACKFILL goes to BACKFILL_HISTORY, RECONCILE to RECONCILIATION_CANDIDATE, both never mutate live state. Why: BACKFILL/RECONCILE must not masquerade as live evidence, and CLOSED candles stay immutable.
- Broker/internal candle comparison returns a DiscrepancyResult outcome with point metrics against a configurable tolerance, never a boolean. Why: TRS-03 needs analysable deltas, not assumed Exness values.
- The MT5 bridge (src/core/broker/bridge) exposes only whitelisted SYSTEM/DISCOVERY/MARKET_DATA capabilities through typed methods; generic invoke() is SYSTEM-only. Why: no generic bypass to an execution or untyped surface.
- The MetaTrader5 package is imported only in vps/mt5_bridge/native.py, behind a whitelist proxy; the adapter connects to a pre-authenticated terminal and takes no account identity or secrets. Why: native read-only boundary stays isolated from the TypeScript app and from execution.
- The VPS gateway (vps/mt5_gateway) is a stdlib-only, loopback-bound HTTP/WS transport with a static typed route table over ReadOnlyMT5Adapter; no generic dispatch and no native access. Why: network reachability must never grant execution authority.
- The app reaches the gateway only through BrokerGatewayClient (src/core/broker/gateway): typed per-route methods, strict envelope validation, and ticks enter BrokerFeedPipeline via GatewayMarketIngest, never CandleAggregator directly. Why: unvalidated or unclassified broker data must never become evidence.
- BrokerGatewayClient receives its WebSocket constructor by injection (wsFactory); src/ never constructs a socket itself. Why: intentional DI boundary that keeps the frozen 3.0A "no WebSocket( in src" invariant and lets tests drive the stream deterministically.
- Real broker audit UI (src/components/BrokerAuditTerminal.tsx, /audit) reads only via BrokerGatewayClient and pure helpers in src/core/broker/audit; it never mutates, fills or ingests data. Why: audit surfaces discrepancies, it must not create evidence.
- The primary terminal (`/`) shows only validated, symbol-keyed REAL broker observations via BrokerGatewayClient; quote polling is separate from BACKFILL bar viewing and never ingests evidence. Why: read-only market viewing must not misrepresent mocks, cross-symbol responses, or historical data as live mutations.
- History→live bootstrap runs through BootstrapCoordinator (src/core/broker/bootstrap): LIVE is buffered during bootstrap, history stays BACKFILL, only LIVE_MUTATION moves LiveAcceptedFrontier, and failure or unresolved handoff uncertainty ends in DEGRADED, never SYNCHRONIZED. Why: PRE-2D R4, request completion ≠ market synchronization.
- Every occurrence is classified once by ObservationIdentityRegistry (src/core/broker/identity): observation_id is transport identity, fingerprint is evidence only; identical content is flagged AMBIGUOUS_COLLISION and preserved, never dropped; storage sits behind IdentityStore with pinning. Why: PRE-2D R6 (silent_ambiguous_drops = 0) and room for R7 bounded retention.
- Missing intervals are MissingInterval objects (src/core/candles/MissingInterval.ts) with explicit reasons, never candles; no session contract is hardcoded, so absent authority yields OUTSIDE_SESSION_CONTRACT_UNRESOLVED. Why: PRE-2D R5, uncertainty must not become fabricated OHLC or assumed broker failure.
- Retention is owned per layer: BoundedIdentityStore (identity, no eviction while pinned), BrokerFeedPipeline retention (evicts only clean LIVE/BACKFILL records), CandleStore (bounded CLOSED candles, append-only, explicit HistoryRequirement status). Why: PRE-2D R7, memory pressure may degrade availability but never market semantics.
- InternalAggregatedBar and BrokerObservedBar (src/core/candles/BarSchemas.ts) are separate types; compareBars reports volumes side by side and never subtracts or copies them. Why: PRE-2D R8, observed_tick_count != tick_volume != real_volume.
- Technical Validation Probe (src/probe/technical) is an audit/research instrument, NOT Stage 4: outputs are DIAGNOSTIC_PROBE with authority NONE, never EvidenceState/decisions/signals; core/components/routes must never import src/probe, and its algorithms must not be promoted into Stage 4, which is built later from its own formal contracts. Why: test Stage 3 temporal semantics without starting technical intelligence early.
