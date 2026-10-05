# Technical Validation Probe v1b — SPECIFICATION ONLY (blocked on D2)

Chain under test: Gateway → BrokerGatewayClient → history BACKFILL + LIVE → BootstrapCoordinator → ObservationIdentity → AnomalyClassifier → BrokerFeedPipeline → canonical state → LiveCandleFanout → M5/M15/H1/H4 → probe.
Must run on application wiring, never test-only wiring.

1. Real LIVE ticks enter only via pipeline LIVE_MUTATION.
2. Real BACKFILL history stays BACKFILL_HISTORY; never mutates live candles.
3. Bootstrap handoff: LIVE buffered during bootstrap; failure → DEGRADED.
4. Overlap/dedup via ObservationIdentity; silent_ambiguous_drops = 0.
5. Canonical candle formation from accepted LIVE only.
6. Time-driven closure via CanonicalClock (checkBoundary), closed_at >= close_time.
7. Fanout independence across M5/M15/H1/H4.
8. Probe technical state during live operation uses CLOSED bars only; FORMING changes never alter it.
9. Restart + replay equivalence: record accepted evidence, replay through ReplayClock, diagnostics byte-equal.
10. Reconnect/epoch: stale epoch never mutates state; audit trail kept.
11. Missing intervals surfaced as MissingInterval, indicator continuity flagged.
12. LIVE technical result vs deterministic replay of the exact same evidence: identical EMA/ATR/causal swings incl. available_at.
Acceptance additionally requires prefix/no-future-evidence check on the live-recorded series.
