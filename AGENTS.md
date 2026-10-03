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
- Broker data flows RawBrokerEvent → BrokerNormalizer → AnomalyClassifier → BrokerFeedPipeline; only ACCEPT/ACCEPT_WITH_FLAG reach CandleAggregator, everything else stays in the audit log with provenance. Why: the aggregator never repairs broker irregularities and CLOSED candles stay immutable.
- Broker/internal candle comparison returns a DiscrepancyResult outcome with point metrics against a configurable tolerance, never a boolean. Why: TRS-03 needs analysable deltas, not assumed Exness values.
- The MT5 bridge (src/core/broker/bridge) exposes only whitelisted SYSTEM/DISCOVERY/MARKET_DATA capabilities through typed methods; generic invoke() is SYSTEM-only. Why: no generic bypass to an execution or untyped surface.
