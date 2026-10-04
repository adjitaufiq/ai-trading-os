# Personal AI Trading OS — Master Architecture & Execution Order

Status: RATIFIED WORKFLOW (planning document). It does not change PRE-2D or the locked authority model.
Current: Stage 3 MARKET DATA FOUNDATION — PRE-2D FAIL. Next coding: Patch A (R1–R3) → Patch B → Patch C (R4).
Real MT5/Exness: LOCKED. OPERATING_MODE = MONITOR_ONLY. Execution capability ABSENT, authorization DISABLED.

## No-bypass rules (apply to every stage)

1. Stages run strictly in order. A stage starts only after the previous one is ratified with passing tests.
2. No stage may be skipped, merged, or started early "because the code is ready".
3. Real MT5/Exness connects only at 3.0B-2D, after PRE-2D PASS.
4. Execution code does not exist before Stage 10. LIVE (Stage 11) only via MONITOR_ONLY → USER → DEMO → validation → LIVE.
5. NO AI AUTHORITY. LLM output is always `AI_INTERPRETATION` evidence, never a decision.
6. Strategy changes only via Stage 9 Lab (KEEP/MODIFY/REJECT) + human/controlled promotion. Never automatic.
7. Outcome does not rewrite history. Journal entries are append-only.
8. Database/event store is authoritative; spreadsheets are projections/exports only.

## Data flow

```text
STREAM A — MARKET / BROKER
Exness MT5 → Market Data Foundation (ticks/history, temporal integrity, canonical candles,
feed sync, provenance) → Technical Intelligence → Strategy Engine → Guard / Safety ─┐
                                                                                    │
STREAM B — EXTERNAL INTELLIGENCE                                                    │
Official APIs · Economic Calendar · Firecrawl · Browser Use · News/Reports          │
  → External Evidence Store → AIGateway → [9Router] → LLM A/B/C                     │
  → AI_INTERPRETATION ──────────────────────────────────────────────┐               │
                                                                    ▼               ▼
                                                        Evidence / Decision (NO AI AUTHORITY)
                                                           │                         │
                                                    Execution Layer           Decision Journal
                                                                                     │
                                                                     Trading Experience Library
                                                                       │                  │
                                                         Spreadsheet XLSX/CSV      AI Analyst Review
                                                                       └────────┬─────────┘
                                                                     Research Hypotheses
                                                                                │
                                                          Stage 9 Lab (validation / replay)
                                                                                │
                                                                   KEEP / MODIFY / REJECT
                                                                                │
                                                                 Strategy Knowledge Library
```

## Components

### 1. AIGateway + 9Router sidecar (Stage 8)
TradingOS → AIGateway (internal contract) → 9RouterAdapter → 9Router → providers/models.
Every result records actual provider/model and fallback provenance.
LLM can: research, explain, summarize, compare, review, propose hypotheses.
LLM cannot: alter broker facts, alter canonical candles, manipulate EvidenceState, bypass Guard,
authorize orders, autonomously modify production strategy.

### 2. External Research Acquisition (Stage 7)
Firecrawl = primary retrieval (search/crawl/scrape/extract). Browser Use = operator for interactive
sites (dynamic pages, pagination, date filters, downloads, sessions). Not substitutes.
Research Planner → Official / Firecrawl / Browser → Raw Documents → Normalize/Dedupe →
Verify/Corroborate → ExternalEvidence → AI Interpretation. Source provenance always preserved.

### 3. Automated Decision Journal (Stage 12)
Lifecycle: SETUP CREATED → ACTIVE → (INHIBITED | EXPIRED | INVALIDATED | SIGNAL → EXECUTION → TRADE →
TP/SL/BE/TRAILING/MANUAL) → REVIEW. Non-trades are data too.
Records: why setup/signal/guard decision, evidence at that time, regime, external context;
entry/SL/TP, size, slippage, spread, latency; MAE, MFE, R-multiple, PnL, exit reason;
decision quality, execution quality, financial outcome; AI post-trade review; research hypothesis.

### 4. Human Research Workbook (Stage 12)
Personal_AI_Trading_Lab.xlsx (projection): Dashboard, Trades, Setups, Signals, Inhibited_Setups,
Evidence, Guards, Execution, Market_Regimes, External_Context, AI_Reviews, Mistakes, Counterfactuals,
Hypotheses, Strategy_Performance, Primitive_Performance, Research_Library.

### 5. Two knowledge libraries
- Strategy Knowledge Library (Stage 9): StockSharp 3,811 corpus, Jesse, SMC primitives, papers,
  extracted primitives, market hypotheses, KEEP/MODIFY/REJECT.
- Trading Experience Library (Stage 12): actual setups, trades, inhibited setups, profitable mistakes,
  valid losses, execution mistakes, regime behavior, guard effectiveness, counterfactuals, AI reviews.

### 6. Controlled learning loop
Experience Library + Strategy Knowledge + External Evidence → AI Research Analyst → Hypothesis H-xxxx
→ Stage 9 Lab → Temporal Audit → Replay → Out-of-Sample → Robustness → KEEP/MODIFY/REJECT
→ Human/controlled promotion → New Strategy Version.
Forbidden: loss → AI changes strategy → trade again.

## Roadmap (execution order)

| Stage | Name | Status |
|---|---|---|
| 0 | Foundation | FROZEN |
| 1 | Research Spec | ACTIVE / PARALLEL |
| 2 | Application Skeleton | DONE |
| 2.1 | Temporal Foundation | FROZEN |
| 3 | Market Data Foundation | CURRENT — PRE-2D FAIL; Patch A R1–R3 → Patch B → Patch C |
| 4 | Technical Intelligence | |
| 5 | Chart + Manual Structure | |
| 6 | Strategy + Guard Engine | |
| 7 | External Intelligence (official sources, Firecrawl, Browser Use, Evidence Store, orchestration) | |
| 8 | AI Analyst (AIGateway, 9Router candidate, Macro/News/Verification/Trade Reviewer/Research analysts) | |
| 9 | Replay / Research Lab (Strategy Knowledge Library, StockSharp corpus, hypothesis testing) | |
| 10 | Demo Execution | |
| 11 | Live Execution | |
| 12 | Review / Learning Loop (Journal, Experience Library, XLSX/CSV, AI review, counterfactuals, mistake taxonomy, hypotheses) | |
