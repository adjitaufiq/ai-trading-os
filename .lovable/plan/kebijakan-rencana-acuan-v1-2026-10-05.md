# Kebijakan Rencana Acuan v1

## Yang dibangun
- Terapkan gate arah deterministik: tren EMA H4/H1 selaras, struktur H1 selaras, RSI14 H1 di sisi 50 yang benar, dan pemicu M5 CLOSED terkonfirmasi. Konflik, RSI tepat 50, atau data kurang menghasilkan HOLD.
- Hitung rencana BUY dari ASK dan swing low H1 terkonfirmasi terakhir; hitung rencana SELL dari BID dan swing high H1 terkonfirmasi terakhir.
- Gunakan buffer `0,25 × ATR14(M15)`, lalu turunkan TP1 = 1R dan TP2 = 2R.
- Tampilkan SL, TP1, TP2, dan R:R pada kartu utama serta panel baca-saja. Jika bukti tidak valid atau risiko tidak positif, jangan tampilkan level.

## Batas keselamatan
- Tetap MONITOR_ONLY dan execution disabled; tidak ada order, gateway, backend, atau mutasi akun.
- Hanya memakai bar CLOSED canonical dan swing kausal yang sudah terkonfirmasi.
- M5 RSI tetap konfirmasi tampilan; hanya RSI14 H1 yang menjadi gate.

## Detail teknis
- Versikan kebijakan baru di deterministic technical engine dan sertakan hasil rencana dalam snapshot, agar UI hanya merender keputusan engine.
- Tambahkan pengujian BUY, SELL, RSI=50, data kurang, swing/ATR tidak valid, aritmetika 1R/2R, dan panel baca-saja.
- Jalankan tes relevan, seluruh suite, pemeriksaan tipe, build, dan verifikasi tampilan mobile.
