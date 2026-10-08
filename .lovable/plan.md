# H4 sebagai Arah Utama (Primary Bias) — perubahan kebijakan engine

## Masalah
Saat ini arah scalp diambil HANYA dari momentum M5/M15 (aturan ARENA "macro tidak pernah memilih BUY/SELL"). Akibatnya pantulan lokal bisa memunculkan "BUY BIAS" walau H4/H1 bearish.

## Aturan baru
1. H4 = primaryBias (BUY/SELL). H4 MIXED/INSUFFICIENT ⇒ tidak ada primaryBias ⇒ WAIT/NOT_EVALUABLE.
2. Alur keputusan: H4 Direction → H1 Confirmation → M15 Setup → M5 Trigger → READY. Semua tahap hanya mencari arah primaryBias.
3. Field terpisah di snapshot engine:
   - `primaryBias`: BUY | SELL | NONE
   - `setupBias`: BUY | SELL | WAIT (hanya boleh sama dengan primaryBias atau WAIT)
   - `counterTrendCondition`: NONE | BULLISH_PULLBACK | BEARISH_PULLBACK (dari momentum M5/M15 yang berlawanan H4)
4. Momentum lawan H4, RSI rebound, EMA bounce ⇒ hanya mengisi `counterTrendCondition` (warning), tidak pernah menjadi sisi signal, rencana acuan, radar plan, paper, atau demo execution.
5. Execution gate (paper + demo VPS) hanya membaca primaryBias + setup yang selaras.

## Tampilan (mobile + desktop)
- Kartu Signal State: "SELL BIAS" + "WAIT SELL TRIGGER", alasan per tahap (H4, H1, M15, M5, lokasi).
- Label "PRIMARY BIAS: SELL"; bila ada momentum lawan: "COUNTER TREND WARNING: BUY PRESSURE".
- "BUY BIAS" tidak pernah tampil saat H4 bearish (dan sebaliknya).

## Dampak yang perlu diketahui
- Menggantikan aturan ARENA yang sudah diratifikasi; versi kebijakan dinaikkan (operator, MTF, radar plan, signal TTL) sehingga statistik journal lama dan baru dipisah per versi.
- Jumlah sinyal kemungkinan turun (tidak ada lagi entry counter-trend).
- Backtest cepat otomatis memakai aturan baru (replay fungsi yang sama).

## Detail teknis
- `src/core/technical/operator.ts`: side = macroDirectionOf(H4); momentumSide hanya untuk konfirmasi M5/M15 searah atau `counterTrendCondition`; H1 counter-trend ⇒ WAIT_CONFIRMATION tetap. Bump ARCHITECTURE_VERSION/OPERATOR policy.
- `src/core/technical/tradingState.ts`: tambah tiga field ke TradingSnapshot; buildSidePlan/radar plan/lifecycle dipanggil hanya dengan primaryBias.
- `src/core/paper/LivePaperLoop.ts` + jalur demo VPS: tolak sisi ≠ primaryBias (BLOCKED reason COUNTER_PRIMARY_BIAS).
- UI (`MobileTradingView.tsx`, `TechnicalSlicePanel.tsx`): proyeksi field baru saja, tanpa kalkulasi.
- Update `src/core/technical/AGENTS.md` (ganti aturan "macro never picks BUY/SELL").
- Tes: H4 bearish + momentum naik ⇒ SELL BIAS + BULLISH_PULLBACK warning, tidak ada BUY plan; H4 bullish mirror; H4 MIXED ⇒ WAIT; update tes arena-p01/p02/p03/mtf yang mengunci aturan lama. Jalankan seluruh suite + typecheck.
