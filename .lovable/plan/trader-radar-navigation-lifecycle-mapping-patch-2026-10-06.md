# Trader Radar Navigation & Lifecycle Mapping Patch

## Scope
Presentation-layer patch only. Preserve every engine, runtime, radar, signal, plan, risk, paper-execution, and journal calculation. Keep every existing card; only adjust navigation, placement, and UI mapping.

## Changes
1. Replace the mobile top tab strip with a fixed bottom navigation for TRADE, RADAR, and ANALYSIS; keep TRADE as the default and reserve bottom spacing so content is never covered.
2. Restore the TRADE flow to one continuous lifecycle: Signal State → Market Context → Rencana Acuan → status/paper positions.
3. Create one shared presentation projection from existing authoritative fields only, then use it consistently in Signal State and Rencana Acuan:
   - actionable LONG/SHORT candidate → BUY/SELL READY
   - existing projected CARI_BUY/CARI_SELL or radar side → BUY/SELL BIAS · WAIT TRIGGER/CONFIRMATION
   - no existing direction → HOLD · WAIT CONFIRMATION
4. Preserve available projected entry, SL, TP, and R:R values from the existing radar plan even while waiting; never fabricate missing values.
5. Keep directional context readable: bullish green, bearish red, sideways/unknown neutral; HOLD action controls remain neutral and disabled.
6. Keep RADAR limited to scalp momentum, price location, EMA, structure, and trading style with no entry controls.
7. Keep ANALYSIS for WHY, technical details, radar/runtime observability, and engine context; engine context stays expanded by default and remains manually collapsible.

## Verification
- Add focused tests for default TRADE, bottom navigation switching, exact TRADE card order, and default-open engine context.
- Test one shared direction across Signal State and Rencana Acuan, including projected BUY/SELL while HOLD and true no-direction fallback.
- Reconfirm HOLD cannot open paper actions and BUY/SELL safety remains unchanged.
- Run the focused cockpit/radar-plan tests, check build diagnostics, and inspect the 411px mobile preview for fixed navigation and non-overlapping content.
