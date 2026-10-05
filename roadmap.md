# Stage 3 PRE-2D gap closure
- [x] Patch B — R4 bootstrap + R6 observation identity (approved to proceed; independent source audit pending)
- [x] Patch C — R5 gap contract, R7 bounded retention, R8 internal vs broker bar (candidate for full PRE-2D audit)
- [ ] Full PRE-2D integration + regression + independent source audit (blocked: awaiting explicit user instruction)

## Patch B audit debt (must carry into Patch C / PRE-2D audit)
- [ ] D1: REJECT → AMBIGUOUS_COLLISION/ACCEPT_WITH_FLAG test change (tick_count 2→3) — confirm in source audit that only fingerprint-equal/identity-different cases changed; same raw_event_id stays EXACT_TRANSPORT_DUPLICATE.
- [ ] D2: Real-chain integration gap — BootstrapCoordinator not wired into Gateway → BrokerGatewayClient → history + LIVE → Bootstrap → Identity → Pipeline → canonical state. 178 core tests do NOT prove production handoff.
- [ ] D3: Drain order (source_event_ms, connection_epoch, sequence, arrival) — tie-break must be deterministic processing order only, never inferred market/causal order; same-ms ambiguous occurrences must not gain transport-sequence "market truth".
