# Selesaikan scope PR (item 1–5), tanpa publish

Status sekarang:
- Item 1–3 (rename ke BLOCKED_COUNTER_PRIMARY_BIAS, isi audit lengkap, alur ke engine log / journal / Telegram) sudah ada di code.
- Item 4 (H4 primaryBias hanya berubah dari H4 yang sudah close) belum punya test eksplisit.
- Item 5 (paket VPS) perlu dibangun ulang setelah semua test hijau.

## Pekerjaan
1. **Item 1 — rename:** pastikan tidak ada lagi `COUNTER_PRIMARY_BIAS` tanpa awalan `BLOCKED_` di code, test, AGENTS.md, maupun formatter Telegram.
2. **Item 2 — isi audit:** perluas test executor supaya mencakup dua sisi:
   - SELL saat H4 BUY → BLOCKED dengan `attemptedSide`, `primaryBias`, `counterTrendCondition`, dan `timeframeConflict`.
   - Fallback ke radar `h4Bias` saat `primaryBias` tidak ada → `source: RADAR_H4_STATE`.
3. **Item 3 — alur event:** tambah test bahwa event BLOCKED demo memetakan isi audit ke `timeframe_context`, dan `block_reason` diawali `BLOCKED_COUNTER_PRIMARY_BIAS`. Test komposisi Telegram memastikan block_reason tampil di alert EXECUTION BLOCKED.
4. **Item 4 — persistence H4:** test baru di level `operatorAnalysis`/`evaluate`, hanya test, logic tidak diubah:
   - H4 bearish yang sudah close, ditambah candle H4 yang masih berjalan dan naik tajam (seharusnya membalik arah) → `primary_bias` tetap SELL dan tidak ada plan/intent BUY.
   - Setelah candle H4 berikutnya benar-benar close dan membalik struktur → baru `primary_bias` boleh berubah.
   - Test tingkat TechnicalSliceService: bar FORMING / bar dengan `available_at > asOf` tidak masuk ke input H4.
5. **Item 5 — paket VPS:** jalankan test terkait, typecheck penuh, dan seluruh suite yang ada (catat kalau ada yang gagal di luar scope tanpa memperbaikinya). Setelah itu rebuild `arena-engine-host-deploy.zip` dan pastikan zip berisi guard baru dan wiring `primaryBias`. Tidak publish.

## Di luar scope (tidak disentuh)
RLS, heartbeat/failover, D1/D3, G2/v1b, M8, roadmap cleanup, perubahan logic engine.

## Detail teknis
- Area test: `src/core/execution/demo/demo.test.ts`, test events/telegram yang sudah ada (`src/lib/assistant/telegram.test.ts`), dan file test baru `src/test/h4-primary-persistence.test.ts` yang memakai rig bar yang sama dengan `arena-p01-macro-scalp.test.ts`.
- Perintah verifikasi: `bunx vitest run <file terkait>`, `bunx tsgo --noEmit -p .`, `bunx vitest run`, `bash scripts/build-deploy-zip.sh`, lalu cek isi zip dengan `unzip`.
