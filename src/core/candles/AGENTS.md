- InternalAggregatedBar and BrokerObservedBar (src/core/candles/BarSchemas.ts) are separate types; compareBars reports volumes side by side and never subtracts or copies them. Why: PRE-2D R8, observed_tick_count != tick_volume != real_volume.

- Missing intervals are MissingInterval objects (src/core/candles/MissingInterval.ts) with explicit reasons, never candles; no session contract is hardcoded, so absent authority yields OUTSIDE_SESSION_CONTRACT_UNRESOLVED. Why: PRE-2D R5, uncertainty must not become fabricated OHLC or assumed broker failure.
- CandleAggregator skew tolerance (from ClassifierConfig.maxSourceTimeSkewMs) defers next-bucket ticks until the canonical clock reaches close_time; bars never close early. Why: source clock runs a few seconds ahead of bridge/client.
