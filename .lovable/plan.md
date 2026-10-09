# PR: H4 pivot tie-rule alignment (canonical rule B)

Approved rule for trading swings:
- HIGH pivot: strictly higher than the left neighbours, and higher than or equal to the right neighbours.
- LOW pivot: the mirror rule (strictly lower on the left, lower or equal on the right).
- A run of equal highs or lows gives exactly one pivot, on the first bar of the run.
- confirmedAt does not change (pivot open + 3 × tf).

Out of scope: PrimaryBias → M2, journal provenance/filtering, the research probe, M1B.3 production logic, publish, deploy.

## Changes
1. `src/core/technical/indicators.ts` — `causalSwings`: the right neighbours `bars[i+1]`, `bars[i+2]` use `>=` / `<=`. The left neighbours keep `>` / `<`. Nothing else changes.
2. `src/core/technical/operator.ts` — the minimal version bump the technical AGENTS rule requires:
   - `OPERATOR_POLICY_VERSION` `operator-v2.3-mtf-classification` → `operator-v2.4-pivot-tie-first-owner`.
   - Update any test that asserts the exact version string.
3. `src/core/technical/AGENTS.md` — one new rule:
   - The left comparison is strict and the right allows equality.
   - The first bar of an equal run owns the pivot, so the result is deterministic.
   - The full closed right-side window is still required, with no look-ahead exception for ties.
   - The probe stays strict and has no trading authority.

## Tests (production functions only)
- New `src/test/pivot-tie-rule.test.ts`, run against ARENA `causalSwings`/`structureOf`:
  - A: equal HIGH on the right side.
  - B: equal LOW on the right side.
  - C: HIGH plateau.
  - D: LOW plateau.
  - E: equal LEFT neighbour is rejected.
  - F: no duplicate pivots.
  - G: `confirmed_at` equals right bar #2 close and needs both right bars.
  - H: a FORMING or missing right bar means no early pivot.
- New `src/engine/core/swing/tests/tieRule.test.ts`: the same A–H cases against the production `SwingDetector`, proving its existing behaviour already matches.
- Primary bias regression, fed through `operatorAnalysis`:
  - Fixture: a closed H4 history where a new high equals the previous swing high (double top).
  - Expected result: structure has `EQUAL_HIGH`, so MIXED, so `primary_bias` NONE / WAIT.
  - The old strict rule ignored that bar and kept a stale HH_HL / BUY. The test asserts NONE.
- Probe test #24 stays unchanged.

## Validation
- Run the targeted tests first.
- Then `bunx tsgo --noEmit -p .` and `bunx vitest run` (baseline 939/939).
- Look at any failing existing test one by one. Update it only if its old expectation is clearly stale under rule B.
- If a failure is unrelated, stop and report it.

## Report
Files changed, the comparison diff, tests, version old → new, test/typecheck/suite results, commit SHA (auto-commit), confirmation that confirmedAt and the probe are unchanged, and the replay/backtest impact: version bump, so earlier backtests are not comparable on equal-extreme bars.
