# Read-only technical audit — Personal AI Trader engine and Engine Host

This is an audit report only. Nothing changes until you approve a separate build task. Every point comes from the current code.

## 1. What the engine has

There are two analysis systems:
- **ARENA** (`src/core/technical/indicators.ts`, `operator.ts`, `tradingState.ts`, run by `TechnicalSliceService`). It decides direction, feeds the Radar and the reference plan, and is what the demo order check reads.
- **M1B** (`src/engine/core/*`, run by `LivePaperLoop`). It finds setups for paper trading.

| Category | Component (file / function) | Timeframe | Output | Used by |
|---|---|---|---|---|
| A Structure | ARENA `causalSwings`, `structureOf`, `structureEvents` (BOS/CHOCH), `trendState` | M5–H4 (H4 sets direction) | swings, HH/HL/LH/LL, trend state | `operatorAnalysis` → primaryBias |
| A Structure | M1B `SwingDetector`, `buildStructure`, `detectStructureShift`, `biasEngine` | M15/H1/H4 | swings, structure, M1B bias/phase | M2 setup (its bias is now only a hint) |
| B Trend | ARENA `ema` 5/21/50, `emaRelation`, `emaZone`, `scalpMomentumTf` (EMA slope/gap) | all | relation, H4 trend, momentum | bias (H4 EMA21/50), warning flags |
| B Trend | M1B `calculateEMA`, `classifySlope`, `computeEMAContext` | M15/H1 | EMA context | reaction confirmation |
| B Trend | SMA | none | — | — |
| C S/R | ARENA `buildZones` (swing clusters within 0.5×ATR), `withConfluence`, `nearestLevels` | M15/H1/H4 | zones, confluence | caps TP2, Radar, overlay plan |
| C S/R | M1B `priceLocationEngine` (range position, key level) | M15/H1 | location, keyLevel | M2 candidates, invalidation level |
| D Momentum | `rsiWilder` 14 + `rsiDirectionGate` | H1 | pass/fail | reference plan gate |
| D Momentum | MACD, stochastic | none | — | — |
| E Volatility | `atrWilder` 14 / M1B `computeAtr` | M15 (plans), others | ATR | SL/TP, zone width, sizing |
| E Volatility | `regime/volatilityClassifier`, `regimeClassifier` | — | regime label | for information only |
| F Volume | tick volume is read from bars | — | not used | — |
| F Volume | sweeps (`market/events`), `institutionalRadar` | M15/H1 | events | market context only |
| G Price action | `readPatterns`, `engulfing`, hammer/star patterns, `rejectionWick` (ARENA) and `detectCandlePattern` (M1B) | M5/M15 | trigger patterns | ARENA trigger, M1B reaction |
| H Smart money | `orderBlockDetector`, `fvgTracker` | M15/H1 | order blocks, FVGs | market context only, never a trigger |

## 2. Decision pipeline

```text
MT5 (VPS) -> BrokerGatewayClient (envelope check) -> Normalizer -> AnomalyClassifier
 -> BrokerFeedPipeline (only LIVE_MUTATION) -> CandleAggregator M5/M15/H1/H4 (CLOSED only)
 + BACKFILL history (separate store) -> MarketRuntime
   |- TechnicalSliceService (ARENA) -> primaryBias (H4)
   '- LivePaperLoop (M1B) -> M2 setup -> [H4 gate via evaluateAt] -> M3 plan -> M4 risk
        -> paper open -> journal -> DemoExecutionBridge (guards) -> VPS :8100 -> MT5 demo
```

1. **Who sets the final direction (bias):** ARENA `operatorAnalysis.primaryBias`, from closed H4 bars only.
2. **What feeds it:** H4 EMA21/EMA50 plus H4 structure. H1 can only confirm or downgrade the label.
3. **Who can approve an entry:** M2 marks it READY, M4 approves the risk, and the demo bridge must not block it.
4. **Who can reject an entry:**
   - the M2 direction gate (`COUNTER_PRIMARY_BIAS` / `NO_PRIMARY_BIAS`)
   - M3 rejecting an invalid plan
   - M4 limits
   - bridge guards: mode, duplicate, plan, `BLOCKED_COUNTER_PRIMARY_BIAS`, account, safety limits and kill switch, symbol info, lot size
5. **Conflicts between modules:** final direction is protected twice (the M2 gate and the bridge). Calculations are still duplicated: EMA, ATR, swings, zones and candle patterns each exist in both ARENA and M1B. There are also separate SL/TP formulas: ARENA `buildSidePlan` and M1B M3. The two can disagree on levels.

## 3. How the timeframes work together

- **H4:** the only source of direction.
- **H1:** confirms or warns (pullback), and holds the RSI gate.
- **M15:** setup, zones and key level.
- **M5:** trigger timing, judged on closed bars.
- There is no M1 or M2 timeframe; "M2" is the setup stage name, not a timeframe.
- Lower timeframes cannot override H4. Opposing momentum only creates a warning (`counter_trend_condition`).
- Conflicts are resolved as follows: H4 MIXED or not enough data means NONE/WAIT, and a direction flip drops pending setups.

## 4. EMA

- ARENA uses EMA 5, 21 and 50, seeded with an SMA. On H4, EMA21/50 is **trend context (A)**. On M5/M15, EMA slope and gap give a **momentum warning (C)**. `emaZone` is used for location.
- M1B uses EMA 5/21/50 for **reaction confirmation (C)**.
- EMA is never a direct entry trigger or a risk filter.

## 5. Support/resistance

- **How zones are made:** confirmed swing highs and lows on the same timeframe are clustered within 0.5×ATR14. The data is closed broker bars (BACKFILL history plus live). Timeframes are M15, H1 and H4.
- **Shape:** zones (low/high bands), not lines. A zone is support, resistance or mixed.
- **Strength:** touch count and confluence across timeframes. There is no validated strength score.
- **Price reaction:** checked in M1B `reactionEvaluator` (pattern plus location plus EMA). ARENA uses zones only to cap TP2.
- **Weaknesses:**
  - zones overlap across timeframes, and the two systems can produce duplicate levels
  - mixed zones are noisy
  - old zones are not aged out except by the swing window
  - timeframe priority exists only for visual confluence
  - the Engine Host SNR endpoint is still 404, so the overlay cannot show anything

## 6. Signal quality

| Module | Keep | Improve | Remove | Reason |
|---|---|---|---|---|
| ARENA H4 trend / primaryBias | yes | — | — | single direction source |
| ARENA structure (BOS/CHOCH) | yes | — | — | feeds H4 trend |
| M1B structure / bias | — | make it diagnostic only | its bias role | duplicates ARENA |
| EMA in both systems | yes | share one function | — | duplicated maths |
| ATR in both systems | yes | share one source | — | duplicated, may differ slightly |
| ARENA `buildZones` | yes | add aging, mixed-zone policy | — | noisy and stale levels |
| M1B location / keyLevel | yes | line it up with ARENA zones | — | second set of S/R levels |
| H1 RSI gate | yes | use the same gate in M2 | — | applied to the reference plan only |
| Candle patterns (2 sets) | yes | one detector | — | possible false triggers and mismatches |
| M3 SL/TP and `buildSidePlan` | — | keep one formula | one of the two | conflicting levels |
| Volatility regime | yes | — | — | information only, unvalidated |
| Sweeps / order blocks / FVG | yes | — | — | context only, unvalidated |
| Volume | — | — | — | read but unused (tick volume) |

## 7. What is missing

**A. Critical before demo execution**
1. The readiness routes are not deployed on the VPS (404).
2. A stable tunnel or hostname for the Engine Host and gateway; current URLs change and cause the HTTP_530 alerts.
3. Open demo positions are not captured in the journal (only closed trades are).
4. No end-to-end test of the :8100 execution server; tests are mock-only.
5. One SL/TP formula (M3 vs `buildSidePlan`).
6. Replay/backtest has no primary-bias provider, so it fails closed and backtesting M2 is impossible.
7. The published app's endpoint is out of sync with preview, so the cloud capture and Telegram alerts read a stale address.

**B. Useful improvements**
- shared EMA/ATR/swings between the two systems
- one trigger detector
- the H1 RSI gate inside M2
- zone aging
- the SNR endpoint
- Phase 6A server tests

**C. Not necessary**
- MACD, stochastic, Bollinger, SMA, Fibonacci
- volume confirmation (tick volume is unreliable)

## 8. Health report

**Maturity scores (out of 10):**
- Data: 8. Strict validation, BACKFILL kept separate, closed bars immutable.
- Analysis: 6. Works, but duplicated and partly unvalidated.
- Decision: 7. Single direction source, fails closed.
- Risk: 6. M4 and bridge limits exist, but there are two SL/TP formulas.
- Journal: 5. Open demo positions are missing, and capture depends on a reachable host.

**Top 10 issues before live demo testing:**
1. Readiness routes not deployed on the VPS
2. Unstable tunnel URLs and published-app endpoint drift
3. Open FILLED positions not journaled
4. Two SL/TP formulas
5. No end-to-end test of the :8100 execution server
6. Duplicated EMA/ATR/swing/pattern calculations in M1B and ARENA
7. Mixed and stale zones
8. H1 RSI gate not applied in M2
9. No replay bias provider, so M2 cannot be backtested
10. No dedicated health check for the :8100 gateway (status is inferred from the account check)

**Recommended next priority:** runtime reliability first. Deploy the readiness routes and set up stable tunnel hostnames. Then journal open demo positions. Only after that, unify the SL/TP formula as its own focused PR.
