# M1B.3 pivot tie-rule audit (READ-ONLY report, no build)

## 1. Current rule comparison
| Engine | File | HIGH | LOW |
|---|---|---|---|
| ARENA `structureOf` → `causalSwings` | src/core/technical/indicators.ts:91-103 | `b.high > x.high` for all 4 neighbours | `b.low < x.low` for all 4 |
| M1B.3 `SwingDetector` (feeds `buildStructure`) | src/engine/core/swing/swingDetector.ts:67-74 | left `>`, right `>=` | left `<`, right `<=` |
| Probe (research only) | src/probe/technical/swing.ts:8-21 | strict both | strict both |

Plain rules:
- Equal LEFT value: both engines reject the bar.
- Equal RIGHT value: ARENA rejects; M1B.3 accepts.
- Run of equal extremes: ARENA gives no pivot at all; M1B.3 gives exactly one pivot, on the FIRST bar of the run (later bars fail their strict left side).
- Both allow an outside bar to be HIGH and LOW at once.

## 2. Authoritative evidence
- M1B.3 `AGENTS.md` line 1 states explicitly: "pivot high > left highs and >= right highs, mirrored for lows". It is documented, but no test covers an equal right-side bar.
- ARENA `causalSwings` has no comment or AGENTS rule about ties, and no test of its own. It matches the probe line for line.
- Probe test `technical-probe.test.ts` #24 "tie policy deterministic: equal highs reject" sets strict rules on purpose. But the probe is research-only (`RETROSPECTIVE_LOOKAHEAD`, `trading_authority: NONE`), and production must never import it.
- No roadmap or docs spec covers ties. Git history only has "Changes" commit messages (a044c95, 8ee87c4), so there is no stated intent. I am not inferring any.
- Verdict: M1B.3's `>=` is written down on purpose, but no test proves why. ARENA's strict rule looks copied from the probe, not chosen for trading. Neither rule was ratified as a trading decision.

## 3. Equal-high / equal-low examples
HIGH: highs 100, 105, 110, 110, 106, 104
- A (strict/strict): bar 2 fails (110 vs 110), bar 3 fails (left 110). Result: no pivot. The double top disappears.
- B (strict-left / >= right): bar 2 becomes the pivot (right side 110 ≥, 106 ≥). Bar 3 fails its strict left side. Result: one pivot, on the first equal bar.

LOW (mirror): lows 100, 95, 90, 90, 94, 96
- A gives no pivot. B gives one pivot at the first 90.

Plateau 110, 110, 110: A gives none; B gives the first bar only. Two tops within 2 bars (110, 105, 110): B keeps the first and drops the second. Neither rule ever creates duplicate pivots.

## 4. Trading impact (same CLOSED H4 history)
- Structure: under A a new high that is a double top is skipped, so the label comes from an older swing. Example: a stale HH stays latest, giving HH_HL. Under B the plateau is a new pivot, so the label can become HH, LH or EQUAL_HIGH (EQUAL makes it MIXED). So HH_HL / LH_LL / MIXED can flip either way.
- primaryBias: it comes from ARENA H4 structure, so it can change between BUY/SELL and NONE.
- S/R zones: A loses exactly the equal-high / equal-low levels (the strongest resistance and support). Zone touch counts and range "bounded" checks change.
- MSS, SL anchors, price location (M1B.3 path): B gives an anchor at the plateau; A could move the stop anchor to an older, farther swing.
- Scope: this happens only when highs or lows are exactly equal. That is rare on H4 with 5-decimal feeds, but on XAUUSD a 2-decimal price can repeat.

## 5. Look-ahead
The tie rule only decides which bar owns the pivot. Both rules need the same 2 CLOSED right-hand bars, so confirmedAt stays pivot open + 3 × tf (canonical rule unchanged). B adds no future data: the first equal bar is published only after right bar #2 closes.

## 6. Recommended canonical rule: B (strict-left / equality-allowed-right)
Why:
- It always produces exactly one pivot per equal run, on the first bar. It never returns zero and never duplicates.
- It keeps double tops and double bottoms, which are key S/R and SL anchors. A drops them silently.
- It is already the documented M1B.3 rule. Only ARENA would need to change.
- It is safe for look-ahead and deterministic.
The probe can stay strict, because it is research and has no trading authority.

Confidence: MEDIUM. The technical reasons are strong, but no ratified spec exists, so this needs your decision.

## 7. Spec or production wrong?
- M1B.3 spec and code agree, and match B. It only lacks a test for an equal right-side bar.
- ARENA `causalSwings` is the one that differs from B. Under B it is the production code to change.

## 8. Migration impact and PR ordering
Production files: `src/core/technical/indicators.ts` (right side `>=` / `<=`), and the policy version bump in `operator.ts` that the technical AGENTS rule requires.
Tests:
- New tie tests for ARENA and M1B.3: HIGH, LOW and plateau cases.
- Recheck operator-v2, arena-p0x, radar-plan and backtest fixtures.
- Probe test #24 stays as is.
History and replay: structure, zones and primaryBias can change on bars with equal highs or lows. Backtest outputs are not comparable across the version bump.

Ordering:
1. Separate small PR: lock tie rule B, change ARENA, add tie tests, bump policy version, add an AGENTS rule in the technical folder.
2. Then the main PrimaryBias → M2 build, with provenance and filtering.
Do not mix them. The tie change moves primaryBias by itself and must be checked on its own.

Alternative: if you choose A, M1B.3 code, its AGENTS rule and its SL/location tests change instead, and ARENA stays as is. The ordering stays the same.
