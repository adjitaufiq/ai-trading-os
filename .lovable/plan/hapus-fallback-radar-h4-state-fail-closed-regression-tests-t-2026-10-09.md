# Hapus fallback RADAR_H4_STATE + fail-closed + regression tests (tanpa publish, tanpa zip)

Spesifikasi di bawah persis sesuai yang lo setujui. Klik Approve supaya build mode terbuka dan implementasi bisa jalan.

## 1. Hapus fallback radar
- `DemoExecutionBridge` hanya membaca `context.primaryBias` sebagai arah eksekusi yang authoritative.
- `intent.context.h4Bias` tetap ada sebagai diagnostic/context saja: tidak menentukan, mengganti, atau mengizinkan arah order.

## 2. Fail-closed
Kalau `primaryBias` null, undefined, NONE, atau unavailable:
- tidak ada order;
- tidak lanjut ke cek akun, ukuran lot, maupun pengiriman order;
- alasan blokir `BLOCKED_COUNTER_PRIMARY_BIAS`, tanpa alasan baru;
- audit berisi `primaryBias: null`, `attemptedSide` sisi yang dicoba, dan `timeframeConflict.source: "PRIMARY_BIAS_UNAVAILABLE"`.

## 3. Arah bertentangan
BUY saat primaryBias SELL, atau SELL saat primaryBias BUY:
- alasan blokir `BLOCKED_COUNTER_PRIMARY_BIAS`, source `TECHNICAL_H4_CLOSED`;
- audit lengkap: `attemptedSide`, `primaryBias`, `counterTrendCondition`, `timeframeConflict`.

## 4. Regression test executor
| Kasus | primaryBias | Sisi dicoba | Radar h4Bias | Harus |
|---|---|---|---|---|
| A | SELL | BUY | – | BLOCKED |
| B | BUY | SELL | – | BLOCKED |
| C | BUY | BUY | – | lolos guard |
| D | SELL | SELL | – | lolos guard |
| E | tidak ada | – | BULLISH | BLOCKED, tidak ada order |
| F | NONE | – | BEARISH | BLOCKED, tidak ada order |

Kasus E dan F membuktikan radar bukan lagi otoritas cadangan.

## 5. Test event, journal, dan Telegram
- Event BLOCKED: `block_reason` diawali `BLOCKED_COUNTER_PRIMARY_BIAS`.
- `attemptedSide`, `primaryBias`, `counterTrendCondition`, dan `timeframeConflict` masuk ke `timeframe_context`.
- Alert EXECUTION BLOCKED di Telegram menampilkan block_reason.
- Ini verifikasi lewat test saja, bukan klaim pengiriman Telegram live.

## 6. Regression H4 closed-bar (jalur produksi)
- H4 bearish yang sudah CLOSED → `primary_bias` SELL.
- Ditambah candle H4 yang masih berjalan dan naik kuat → tetap SELL, tidak ada plan atau intent BUY.
- Bar H4 dengan `available_at > asOf` tidak masuk ke input H4.
- Setelah bar pembalik benar-benar CLOSED, `available_at <= asOf`, dan memenuhi aturan struktur + EMA yang ada → `primary_bias` baru boleh berubah.
- Logic trading tidak diubah. Kalau test menemukan bug yang sudah ada, bagian itu dihentikan dan root cause-nya dilaporkan dulu.

## 7. Cek rename
Cari `COUNTER_PRIMARY_BIAS` tanpa awalan `BLOCKED_` di code produksi, test, AGENTS.md, formatter Telegram, dan formatter event. Teks histori dilaporkan saja.

## 8. Dokumentasi invariant (AGENTS.md teknis)
- Alurnya: analisa teknis dari H4 CLOSED → primaryBias → guard eksekusi.
- Radar h4Bias hanya diagnostic.
- primaryBias tidak tersedia = fail-closed.
- Utang teknis dicatat tanpa diperbaiki: LivePaperLoop/M1B masih menghitung arah H4 sendiri, dan DemoExecutionBridge menjadi titik penegakan terakhir.

## 9. Validasi
- Test vitest terkait.
- `tsgo --noEmit` penuh.
- Seluruh suite vitest.

Hasil dilaporkan dengan jumlah lulus/gagal yang persis, termasuk kegagalan di luar scope.

## Laporan akhir
Commit/versi (SHA tidak tersedia karena git dikelola platform; dilaporkan apa adanya), file yang berubah, hasil test dan typecheck, konfirmasi fallback sudah hilang, konfirmasi fail-closed, hasil test H4, hasil test event/Telegram, dan utang teknis yang tersisa.

## Tidak dikerjakan
Publish, rebuild zip VPS, deploy VPS, perubahan strategi M1B/M2/M3/M4, RLS, heartbeat, G2, v1b, M8, roadmap cleanup.
