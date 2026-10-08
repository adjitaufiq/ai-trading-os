# H4 Primary Bias — satu arah, trend-following

## Masalah
Arah scalp saat ini diambil hanya dari momentum M5/M15 (aturan lama "macro never picks BUY/SELL"). Akibatnya pantulan lokal memunculkan "BUY BIAS" walau H4/H1 bearish.

## 1. Syarat primaryBias dari H4
- primaryBias = SELL hanya jika H4 punya struktur terkonfirmasi LH_LL (searah EMA bearish).
- primaryBias = BUY hanya jika H4 punya struktur terkonfirmasi HH_HL (searah EMA bullish).
- H4 hanya EMA cross tanpa struktur, MIXED, atau data kurang ⇒ primaryBias = NONE ⇒ WAIT.

## 2. Hanya H4 yang menentukan arah
- Alur: H4 Direction → H1 Confirmation → M15 Setup → M5 Entry Trigger → READY.
- RSI, EMA bounce, warna candle, reaksi support/resistance, dan momentum M5/M15 hanya boleh mengisi `counterTrendCondition` (NONE | BULLISH_PULLBACK | BEARISH_PULLBACK).
- Modul-modul itu tidak boleh mengubah `primaryBias`, `setupBias` (BUY | SELL | WAIT, hanya sama dengan primaryBias atau WAIT), atau `executionSide`.

## 3. Hard block di backend
- Paper loop dan demo VPS executor menolak setiap order dengan orderSide ≠ primaryBias ⇒ status BLOCKED_COUNTER_PRIMARY_BIAS, dicatat sebagai event BLOCKED (masuk event log + Telegram).
- Block ini ada di engine dan VPS, bukan hanya di layar.

## 4. Hapus aturan lama
- Hapus "macro never picks BUY/SELL" dan "scalp side comes ONLY from M5/M15 momentum" dari `src/core/technical/AGENTS.md`, `src/core/radar/AGENTS.md`, project knowledge/memory, dan dokumen terkait. Ganti dengan aturan H4 primaryBias tunggal.

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

## Dampak
- Versi kebijakan dinaikkan; statistik journal dipisah per versi.
- Jumlah sinyal kemungkinan turun (tidak ada entry counter-trend).
- Backtest cepat otomatis memakai aturan baru.

## Detail teknis
- `operator.ts`: side = primaryBias dari H4 (struktur + EMA); momentumSide hanya konfirmasi searah atau sumber counterTrendCondition. Bump ARCHITECTURE_VERSION.
- `tradingState.ts`: tambah `primaryBias`, `setupBias`, `counterTrendCondition`; buildSidePlan / radar plan / signal lifecycle hanya dipanggil dengan primaryBias.
- `LivePaperLoop.ts`, engine-host DemoExecutionBridge, `vps/mt5_exec`: guard BLOCKED_COUNTER_PRIMARY_BIAS; paket deploy VPS dibangun ulang.
- UI (`MobileTradingView.tsx`, `TechnicalSlicePanel.tsx`): hanya menampilkan field baru.
- Tes: H4 bearish + momentum naik ⇒ SELL BIAS + BULLISH_PULLBACK, tanpa BUY plan; mirror bullish; EMA-only / MIXED ⇒ NONE; order lawan arah ⇒ BLOCKED di paper dan demo. Update tes arena-p01/p02/p03/mtf. Jalankan seluruh suite + typecheck + tes VPS.
