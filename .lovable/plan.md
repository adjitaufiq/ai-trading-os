# H4 Primary Bias — Macro structure menentukan arah, timeframe kecil menentukan timing

## 1. primaryBias = single source of truth
- primaryBias bukan confidence score; ini satu-satunya arah trade yang diizinkan.
- Selama struktur H4 belum berubah, momentum lokal tidak boleh membalik arah.
- Contoh: H4 = SELL + momentum M5/M15 bullish ⇒ primaryBias = SELL, counterTrendCondition = BULLISH_PULLBACK, setupBias = WAIT atau SELL.
- Dilarang: BUY plan, BUY signal card, BUY execution selama primaryBias = SELL (dan sebaliknya).
- primaryBias = NONE jika H4 hanya EMA cross tanpa struktur, MIXED, atau data kurang.

### Enforcement
- primaryBias dihitung satu kali di layer market structure, lalu diteruskan ke seluruh pipeline.
- Tidak ada modul sesudahnya yang boleh override: radar, momentum engine, RSI evaluator, setup generator, signal aggregator, execution planner.
- Semua modul downstream hanya boleh: (1) menerima primaryBias, (2) memberi status valid/invalid, (3) memberi timing readiness.

### Pipeline ownership rule
- Market structure layer adalah pemilik tunggal primaryBias; semua layer setelahnya consumer, bukan decision maker.
- Jika ada konflik antar modul, primaryBias dari H4 selalu menang.
- Konflik dicatat sebagai diagnostic event, tidak mengubah arah trade.
- Contoh: H4 primaryBias = SELL, momentum module = BUY ⇒ primaryBias SELL, counterTrendCondition BULLISH_PULLBACK, diagnostic LOCAL_MOMENTUM_CONFLICT.

```text
H4 STRUCTURE → PRIMARY BIAS → H1 CONFIRMATION → M15 SETUP → M5 TRIGGER → EXECUTION
```
Bukan: M5 momentum → BUY/SELL → cari pembenaran timeframe besar.

## 2. Aturan perubahan arah H4
- SELL → BUY hanya jika: H4 break bearish structure + terbentuk HH_HL + EMA H4 sejajar bullish.
- BUY → SELL hanya jika: H4 break bullish structure + terbentuk LH_LL + EMA H4 sejajar bearish.
- Tidak boleh mengubah primaryBias: RSI rebound, beberapa candle hijau, EMA bounce M5/M15, reaksi support lokal.

## 2A. PrimaryBias persistence rule
- primaryBias tidak berubah karena fluktuasi candle intraday.
- Setelah H4 menghasilkan primaryBias valid, nilainya dipertahankan sampai ada invalidation atau struktur H4 berlawanan yang valid.
- primaryBias dihitung ulang hanya dari candle H4 yang sudah CLOSE.
- Candle H4 yang masih berjalan tidak boleh membalik primaryBias.
- Alur: H4 close → update bias; M5/M15 → cari timing. Bukan: tick berjalan → ubah bias.
- Tambahan test: candle H4 berjalan naik saat primaryBias SELL ⇒ primaryBias tetap SELL sampai H4 close dengan struktur HH_HL + EMA bullish.

## 3. Counter trend = informasi risiko saja
- Field `counterTrendCondition`: NONE | BULLISH_PULLBACK | BEARISH_PULLBACK.
- Tampil sebagai "COUNTER TREND WARNING: BULLISH_PULLBACK" (harga sedang retracement melawan trend utama).
- Tidak pernah masuk ke signal state, radar plan, side plan, atau execution.

## 4. Hard block + event audit lengkap
- Paper loop dan demo VPS executor menolak order dengan orderSide ≠ primaryBias ⇒ BLOCKED_COUNTER_PRIMARY_BIAS (di backend, bukan hanya UI).
- BLOCKED_COUNTER_PRIMARY_BIAS terjadi di decision layer, sebelum: pembuatan order intent, pengiriman ke DemoExecutionBridge, dan pengiriman ke MT5 executor. Tidak ada order yang dibuat lalu dibatalkan.
- Guard di executor tetap ada sebagai lapisan cadangan.
- Event dicatat lengkap ke engine event log, journal, dan Telegram (jika aktif):
```text
{ reason: "COUNTER_PRIMARY_BIAS", primaryBias: "SELL", attemptedSide: "BUY",
  timeframeConflict: "H4/H1 bearish", counterTrendCondition: "BULLISH_PULLBACK" }
```

## 5. UI memisahkan arah dan timing
Jika H4 bearish, "BUY BIAS / WAIT TRIGGER" tidak boleh tampil. Format (HP + desktop, termasuk Rencana Acuan dan Radar):
```text
PRIMARY BIAS            SELL
SETUP                   WAIT SELL TRIGGER
H4 BEARISH ✓  H1 BEARISH ✓  M15 WAIT SELL SETUP  M5 WAIT REJECTION
COUNTER TREND WARNING   BULLISH_PULLBACK
```

## 6. Ganti aturan lama
- Hapus semua referensi "macro never picks BUY/SELL" dan "scalp side comes ONLY from M5/M15 momentum" (AGENTS.md, project knowledge, memory, dokumen).
- Ganti dengan: "Macro structure determines trade direction. Lower timeframe determines entry timing."

## 7. Regression test
- Case 1: H4 bearish, H1 bearish, M5/M15 bullish pullback ⇒ primaryBias SELL, counterTrendCondition BULLISH_PULLBACK, tidak ada BUY plan, tidak ada BUY execution.
- Case 2: H4 bullish, pullback bearish lokal ⇒ primaryBias BUY, counterTrendCondition BEARISH_PULLBACK, tidak ada SELL plan.
- Case 3: H4 mixed / struktur tidak cukup ⇒ primaryBias NONE, state WAIT atau NOT_EVALUABLE.
- Case 4: execution berlawanan primaryBias ⇒ BLOCKED_COUNTER_PRIMARY_BIAS dengan payload audit lengkap.

- Case 5: H4 SELL valid + momentum BUY kuat di M5/M15 ⇒ primaryBias SELL, setupBias WAIT, counterTrendCondition BULLISH_PULLBACK; UI "SELL BIAS / WAIT SELL TRIGGER"; tidak ada BUY intent yang dibuat sama sekali.
- Case 6: H4 SELL valid + M5/M15 BUY pullback + RSI bullish + EMA bounce ⇒ primaryBias SELL, setupBias WAIT, counterTrendCondition BULLISH_PULLBACK. Dilarang: BUY signal, BUY plan, BUY intent, BUY execution. Alasan: indikator timeframe rendah menjelaskan pergerakan, bukan arah. Override primaryBias oleh RSI atau modul lain tidak diizinkan.

## Dampak
- Versi kebijakan dinaikkan; statistik journal dipisah per versi. Jumlah sinyal kemungkinan turun. Backtest cepat otomatis memakai aturan baru.

## Detail teknis
- `operator.ts`: side = primaryBias dari H4 (struktur + EMA, dengan transisi hanya via struktur); momentumSide hanya konfirmasi searah atau sumber counterTrendCondition. Bump ARCHITECTURE_VERSION.
- `tradingState.ts`: field `primaryBias`, `setupBias`, `counterTrendCondition`; buildSidePlan / radar plan / signal lifecycle hanya dengan primaryBias.
- `LivePaperLoop.ts`, engine-host DemoExecutionBridge, `vps/mt5_exec`: guard + event audit; paket deploy VPS dibangun ulang.
- UI (`MobileTradingView.tsx`, `TechnicalSlicePanel.tsx`): hanya menampilkan field baru.
- Update tes arena-p01/p02/p03/mtf; jalankan seluruh suite, typecheck, dan tes VPS.
