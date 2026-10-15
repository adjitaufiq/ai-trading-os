# READ-ONLY: Rekonsiliasi TP/R:R XAUUSD (tanpa ubah kode/parameter/order)

## Fakta kode (src/core/technical/tradingState.ts)
- `buildSidePlan` (l.321-367) dipakai oleh `reference_plan` DAN `radar_plan` (rumus sama, input bisa beda).
- SELL: SL = swing HIGH M15 terkonfirmasi terbaru di atas entry (fallback M5) + 0.25×ATR14(M15). risk = SL − entry.
- Target struktural = `structuralTargetZone` (l.313): zona M15/H1/H4 TERDEKAT dengan `high < entry`; batas yang dipakai = **zone.high** (tepi atas), bukan low/center.
- tBuf = zone.high + 0.20×ATR; sReward = entry − tBuf.
  - sReward <= 0 → TP1=TP2=null, final_rr=0, BAD_RR "buffered S/R target not ahead of entry" (l.351) — persis pola UI `—/—, 1:0.00`.
  - else TP2 = yang lebih dekat antara raw 2R dan tBuf; final_rr < min → TP1 null, BAD_RR (l.355).
- Tidak ada spread/precision/contract rounding di fungsi ini; entry SELL = BID (signal) atau zone.low (radar proyeksi, l.463).

## Rekonsiliasi angka user
- risk = 4109.68 − 4105.89 = 3.79 (konsisten dengan rumus).
- Hitungan user 4.7R mengandaikan target = 4086.49. Tapi `final_rr=0` + TP null hanya bisa terjadi jika zone.high + 1.71 >= 4105.89, yaitu **ada zona support lain dengan high >= ~4104.18** (tepat di bawah entry), lebih dekat dari 4086.49.
- Angka 4086.49 berasal dari teks Location ("support zone 4086.49...") = output `structuralContext`/operator location, BUKAN `structural_target_raw`. Jadi kemungkinan besar dua angka dari field berbeda; kesimpulan "support terlalu dekat" BELUM terbukti dengan 4086.49 — dugaan: zona penghalang lain yang lebih dekat.
- Status: UNKNOWN sampai field snapshot dibaca.

## Langkah verifikasi (read-only)
1. Ambil snapshot XAUUSD aktual via tunnel market `/v1/engine/snapshot` (sudah diizinkan proxy), catat `as_of`.
2. Baca `radar_plan` dan `reference_plan`: mode/status/reason, entry, anchor, atr14_m15, sl, raw_tp1/2, structural_target_zone (low/high/tf), structural_target_raw/buffered, structural_rr, tp1/tp2, final_rr, economics_status/reason.
3. Hitung ulang aritmetik dari field itu; tandai selisih.
4. Tentukan apakah layar = `radar_plan` mode RADAR (proyeksi, entry=zone.low) atau SIGNAL/reference; bandingkan timestamp keduanya.
5. Konfirmasi lapis penahanan: `entry` WAIT BAD_RR (l.540-542) → LivePaperLoop/Decision Gate tidak membentuk intent → DemoExecutionBridge tidak dipanggil. Kutip tes terkait (radar-plan.test, arena-p06-structural-rr.test).
6. Catatan: snapshot screenshot 09:12 sudah lewat; rekonsiliasi persis butuh snapshot itu — jika tidak tersimpan, laporkan hanya snapshot baru + penjelasan mekanisme.

## Batasan
Tanpa ubah kode, threshold R:R, Risk, strategi, publish, atau order.
