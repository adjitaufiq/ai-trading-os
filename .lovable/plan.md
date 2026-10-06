# Trader Radar Dashboard v2.1

## Scope
Presentation-layer refactor only. Preserve every engine, radar calculation, runtime pipeline, paper execution rule, and journal behavior.

## Changes
1. Lock the visual guard: HOLD, WAIT, NO SETUP, conflict, or unavailable states render neutrally; BUY/SELL paper actions remain visible but disabled and cannot open tickets.
2. Replace the top diagnostic signal with three explicit layers: Market Condition, Setup Condition, and Execution State.
3. Convert engine terminology into trader-readable labels without changing underlying values.
4. Add read-only cards for Market Trend, H4/H1 bias, Scalp Condition, Price Location, EMA Levels/Action, confirmed structures, and Trading Style using existing snapshot fields only.
5. Show REAL_MT5/source, symbol, last tick update, and last CLOSED M5 timestamp separately; missing values show waiting/unavailable states.
6. Rewrite WHY WAIT/WHY READY from existing engine facts only, then retain technical details and journal below.

## Verification
- Add focused tests proving HOLD disables both actions, uses no directional styling, and opens no paper ticket.
- Add focused tests proving the three layers render separately and READY is the only state with a directional active action.
- Run the relevant cockpit tests and inspect the mobile dashboard against the live runtime.
