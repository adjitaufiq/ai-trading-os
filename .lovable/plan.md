# H4 Primary Bias — satu arah, trend-following

## Masalah
Arah scalp saat ini diambil hanya dari momentum M5/M15 (aturan lama "macro never picks BUY/SELL"). Akibatnya pantulan lokal memunculkan "BUY BIAS" walau H4/H1 bearish.

## 1. Syarat primaryBias dari H4
- primaryBias = SELL hanya jika H4 punya struktur terkonfirmasi LH_LL (searah EMA bearish).
- primaryBias = BUY hanya jika H4 punya struktur terkonfirmasi HH_HL (searah EMA bullish).
- H4 hanya EMA cross tanpa struktur, MIXED, atau data kurang ⇒ primaryBias = NONE ⇒ WAIT.

## 1b. Aturan perubahan arah H4
- primaryBias tetap sama selama struktur H4 belum berubah, walau momentum lokal berbalik.
- SELL → BUY hanya jika: H4 menembus struktur bearish, terbentuk HH_HL, dan EMA H4 sejajar bullish.
- BUY → SELL hanya jika: H4 menembus struktur bullish, terbentuk LH_LL, dan EMA H4 sejajar bearish.
- RSI rebound, beberapa candle hijau, EMA bounce M5/M15, atau reaksi support lokal tidak pernah mengubah primaryBias.
- Contoh: H4 SELL + momentum M5/M15 naik ⇒ primaryBias = SELL, counterTrendCondition = BULLISH_PULLBACK, setupBias = WAIT atau SELL.

## 2. Hanya H4 yang menentukan arah
- Alur: H4 Direction → H1 Confirmation → M15 Setup → M5 Entry Trigger → READY.
- RSI, EMA bounce, warna candle, reaksi support/resistance, dan momentum M5/M15 hanya boleh mengisi `counterTrendCondition` (NONE | BULLISH_PULLBACK | BEARISH_PULLBACK).
- Counter trend hanya informasi risiko (harga sedang retracement melawan trend utama); tidak pernah masuk signal state, radar plan, side plan, atau execution.
- Modul-modul itu tidak boleh mengubah `primaryBias`, `setupBias` (BUY | SELL | WAIT, hanya sama dengan primaryBias atau WAIT), atau `executionSide`.

## 3. Hard block di backend
- Paper loop dan demo VPS executor menolak setiap order dengan orderSide ≠ primaryBias ⇒ status BLOCKED_COUNTER_PRIMARY_BIAS, dicatat sebagai event BLOCKED (masuk event log + Telegram).
- Isi event audit (disimpan di engine event log, journal, dan Telegram bila aktif):
```text
{ reason: "COUNTER_PRIMARY_BIAS", primaryBias: "SELL", attemptedSide: "BUY",
  timeframeConflict: "H4/H1 bearish", counterTrendCondition: "BULLISH_PULLBACK" }
```
- Block ini ada di engine dan VPS, bukan hanya di layar.

## 4. Hapus aturan lama
- Hapus "macro never picks BUY/SELL" dan "scalp side comes ONLY from M5/M15 momentum" dari `src/core/technical/AGENTS.md`, `src/core/radar/AGENTS.md`, project knowledge/memory, dan dokumen terkait. Ganti dengan: "Macro structure determines trade direction. Lower timeframe determines entry timing."

## 5. Safety rule: satu sumber arah
- primaryBias adalah single source of truth; tidak boleh ada dua arah signal aktif.
- Jika primaryBias = SELL: rencana BUY, kartu signal BUY, dan eksekusi BUY dilarang (dan sebaliknya).
- BUY baru boleh muncul setelah primaryBias berubah menjadi BUY.

## 6. Target tampilan (kondisi BTCUSD sekarang)
```text
SIGNAL STATE · BTCUSD
SELL BIAS
WAIT SELL TRIGGER

PRIMARY BIAS   SELL
H4             BEARISH ✓
H1             BEARISH ✓
M15            WAIT SELL SETUP
M5             WAIT REJECTION

COUNTER TREND WARNING: BULLISH_PULLBACK
```
"BUY BIAS / WAIT TRIGGER" tidak boleh tampil saat H4 bearish. Berlaku di HP dan desktop, termasuk Rencana Acuan dan Radar.

## 7. Regression test
- Case 1: H4 bearish + H1 bearish + pullback naik M5/M15 ⇒ primaryBias SELL, counterTrendCondition BULLISH_PULLBACK, tanpa BUY plan, tanpa BUY execution.
- Case 2: H4 bullish + pullback turun lokal ⇒ primaryBias BUY, counterTrendCondition BEARISH_PULLBACK, tanpa SELL plan.
- Case 3: H4 mixed / struktur kurang ⇒ primaryBias NONE, state WAIT / NOT_EVALUABLE.
- Case 4: percobaan eksekusi berlawanan primaryBias ⇒ BLOCKED_COUNTER_PRIMARY_BIAS dengan payload audit lengkap.
- Tambahan: RSI rebound / EMA bounce saja tidak membalik primaryBias; pembalikan hanya setelah struktur H4 + EMA berubah.

## Dampak
- Versi kebijakan dinaikkan; statistik journal dipisah per versi.
- Jumlah sinyal kemungkinan turun (tidak ada entry counter-trend).
- Backtest cepat otomatis memakai aturan baru.

## Detail teknis
- `operator.ts`: side = primaryBias dari H4 (struktur + EMA); momentumSide hanya konfirmasi searah atau sumber counterTrendCondition. Bump ARCHITECTURE_VERSION.
- `tradingState.ts`: tambah `primaryBias`, `setupBias`, `counterTrendCondition`; buildSidePlan / radar plan / signal lifecycle hanya dipanggil dengan primaryBias.
- `LivePaperLoop.ts`, engine-host DemoExecutionBridge, `vps/mt5_exec`: guard BLOCKED_COUNTER_PRIMARY_BIAS; paket deploy VPS dibangun ulang.
- UI (`MobileTradingView.tsx`, `TechnicalSlicePanel.tsx`): hanya menampilkan field baru.
- Tes (lihat bagian 7): H4 bearish + momentum naik ⇒ SELL BIAS + BULLISH_PULLBACK, tanpa BUY plan; mirror bullish; EMA-only / MIXED ⇒ NONE; order lawan arah ⇒ BLOCKED di paper dan demo. Update tes arena-p01/p02/p03/mtf. Jalankan seluruh suite + typecheck + tes VPS.
