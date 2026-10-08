# H4 sebagai Arah Utama (Primary Bias) — perubahan kebijakan engine

## Masalah
Saat ini arah scalp diambil HANYA dari momentum M5/M15 (aturan ARENA "macro tidak pernah memilih BUY/SELL"). Akibatnya pantulan lokal bisa memunculkan "BUY BIAS" walau H4/H1 bearish.

## Aturan baru
1. H4 = primaryBias (BUY/SELL) hanya jika H4 punya struktur terkonfirmasi yang searah (HH_HL ⇒ BUY, LH_LL ⇒ SELL). EMA cross tanpa struktur, MIXED, atau INSUFFICIENT ⇒ primaryBias = NONE ⇒ WAIT/NOT_EVALUABLE.
2. Alur keputusan: H4 Direction → H1 Confirmation → M15 Setup → M5 Trigger → READY. Semua tahap hanya mencari arah primaryBias.
3. Field terpisah di snapshot engine:
   - `primaryBias`: BUY | SELL | NONE
   - `setupBias`: BUY | SELL | WAIT (hanya boleh sama dengan primaryBias atau WAIT)
   - `counterTrendCondition`: NONE | BULLISH_PULLBACK | BEARISH_PULLBACK (dari momentum M5/M15 yang berlawanan H4)
4. Momentum lawan H4, RSI rebound, EMA bounce ⇒ hanya mengisi `counterTrendCondition` (warning), tidak pernah menjadi sisi signal, rencana acuan, radar plan, paper, atau demo execution.
5. Hanya H4 yang boleh menentukan primaryBias. RSI, EMA bounce, warna candle, reaksi support, momentum M5/M15 hanya boleh mengisi counterTrendCondition; tidak boleh mengubah primaryBias, setupBias, atau executionSide.
6. Execution gate (paper + demo VPS) hanya membaca primaryBias + setup yang selaras.

## Aturan keselamatan (wajib)
- primaryBias adalah satu-satunya sumber arah. Tidak boleh ada dua arah signal aktif.
- Jika primaryBias = SELL: rencana BUY, kartu signal BUY, dan eksekusi BUY dilarang (dan sebaliknya). BUY baru muncul setelah primaryBias berubah jadi BUY.
- Hard block di backend (paper loop + demo VPS executor), bukan hanya di layar: orderSide ≠ primaryBias ⇒ BLOCKED_COUNTER_PRIMARY_BIAS, tercatat sebagai event BLOCKED.

## Tampilan (mobile + desktop)
- Kartu Signal State: "SELL BIAS" + "WAIT SELL TRIGGER".
- Market Context per tahap: H4 BEARISH ✓, H1 BEARISH ✓, M15 WAIT SELL SETUP, M5 WAIT REJECTION.
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
- `src/core/technical/AGENTS.md`: hapus total aturan "macro never picks BUY/SELL" dan "scalp side comes ONLY from M5/M15 momentum"; ganti dengan aturan H4 primaryBias tunggal.
- Demo executor VPS (engine-host DemoExecutionBridge + vps/mt5_exec) menolak order berlawanan primaryBias; paket deploy VPS dibangun ulang.
- Tes: H4 bearish + momentum naik ⇒ SELL BIAS + BULLISH_PULLBACK warning, tidak ada BUY plan; H4 bullish mirror; H4 MIXED atau EMA-only tanpa struktur ⇒ NONE/WAIT; order BUY saat primaryBias SELL ⇒ BLOCKED_COUNTER_PRIMARY_BIAS di paper dan demo; update tes arena-p01/p02/p03/mtf yang mengunci aturan lama. Jalankan seluruh suite + typecheck.
