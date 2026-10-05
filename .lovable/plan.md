# Trade action controls

## Build
- Add persistent, touch-friendly BUY and SELL controls beside the signal/reference plan.
- Enable only the side authorized by the existing deterministic cockpit signal; HOLD disables both and shows the current reason.
- Open a frontend-only read-only confirmation panel from an enabled side, showing reference entry, pending SL/TP, R:R, confirmations, and “MONITOR ONLY — NO ORDER SENT”.
- Keep all controls disconnected from broker, account, position, and execution APIs.

## Tests
- Cover always-visible controls, HOLD/BUY/SELL enabled states, read-only confirmation content, pending policies, and absence of execution callbacks.
- Run the full test suite and verify typecheck plus the automatic production build.

## Technical details
- Reuse the existing Button design component and semantic bull/bear tokens.
- Keep state local to the cockpit presentation; no gateway, runtime, market-contract, or server changes.
