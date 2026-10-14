# READ-ONLY — Konsolidasi Arsitektur & Kesiapan Auto-Execution DEMO

Waktu bukti runtime: 2026-10-14 19:23 UTC (02:23 WIB). Tidak ada yang diubah. Tidak ada perintah VPS yang diminta.

## 1. Sumber kebenaran runtime

Satu-satunya bukti runtime yang segar: `GET /v1/engine/health` lewat tunnel market (HTTP 200, 19:23:45 UTC). `/v1/engine/execution-status` dan `/v1/engine/version` diblokir proxy di kedua tunnel (404), jadi Shadow, kill switch, arm, dan commit tidak bisa dibaca langsung saat ini.

| Poin | Nilai runtime terbukti | Sumber | Status |
|---|---|---|---|
| Mode | `operating_mode=DEMO`, `demo_execution=DEMO_STRESS_TEST` | health 19:23 UTC | PASS (terbukti) |
| `DEMO_STRESS_TEST` vs `DEMO_EXECUTION` | Bukan kontradiksi. `DEMO_STRESS_TEST` = nama internal mode env DEMO (main.ts:111). `DEMO_EXECUTION` = label tampilan di execution-status saat bridge terpasang (executionStatus.ts:59) | kode | PASS (nama berbeda, satu keadaan) |
| `execution_enabled=false` vs "DEMO_ARMED" | `execution_enabled = bridge terpasang AND Shadow tidak aktif AND kill switch mati` (main.ts executionState, EngineHost.ts:197). `false` sekarang berarti Shadow aktif ATAU kill switch aktif (atau dua-duanya). "DEMO_ARMED" lama kemungkinan merujuk ke bridge terpasang, bukan siap kirim order | health + kode | Mana dari keduanya yang aktif: UNKNOWN |
| Kill switch | Aktif bila ada file `EMERGENCY_STOP`/`DEMO_KILL_SWITCH`, `emergency_stop=true`, atau perintah halt dari cloud | main.ts:236 | Nilai kini: UNKNOWN (laporan terakhir: aktif, historis) |
| Shadow | Default ON; hanya mati bila `EXECUTION_MODE=DEMO` dan tidak ada `SHADOW_MODE=ON` | AGENTS execution | Nilai kini: UNKNOWN (laporan terakhir: BLOCKING, historis) |
| Session arm | Dicek ulang tiap order dari file `data/demo-arm.json` (fail-closed); log `[demo-arm] ARMED/<alasan>` hanya saat berubah | main.ts:240-252 | UNKNOWN. "ARMED" dan "SESSION_ARM_REQUIRED" bisa sama-sama benar di waktu berbeda (file kedaluwarsa) |
| Risk policy | `risk-policy.json` dan default kode sama-sama 2/2/5/0.005/0.02, emergency_stop=false | file repo | Repo PASS; file di VPS UNKNOWN |
| Build di VPS | `BUILD_INFO.json` repo = `83c752f` (2026-10-12). Commit yang lebih baru hanya mengubah dashboard dan proxy, bukan engine | repo | Commit yang sedang jalan di VPS: UNKNOWN (`/version` diblokir) |

## 2. Alur keputusan & order yang sebenarnya

```text
MT5 (VPS) -> gateway 8765 -> MarketRuntime per simbol (candle CLOSED M5/M15/H1/H4)
 -> Radar/TechnicalSlice (bias H4/H1, struktur, SNR lokasi)
 -> LivePaperLoop: setup/trigger M5 -> Decision Gate (M2) -> TradePlan -> Risk M4 (lot dari akun broker)
 -> onApprovedOpen (main.ts:265)
    1. Shadow Guard gate (catat intent dulu, blokir jika aktif)
    2. bridge terpasang?
    3. session arm valid? (kalau tidak: SESSION_ARM_REQUIRED)
    4. symbol diizinkan cloud? (hanya jika agent cloud dipakai)
 -> DemoExecutionBridge: mode, kill switch, sinyal duplikat, maks posisi, maks trade/hari, rugi harian
 -> DemoExecutionLayer preflight: SL, TP, risk, simbol, akun whitelist, batas posisi
 -> mt5_exec (VPS) -> fill -> sync deal history 15s + reconcile tiap order dan tiap 60s
 -> demo-events.jsonl (append-only) -> evaluation/journal
```

BUY dan SELL lewat jalur yang sama; hanya arah dan rumus SL/TP yang dicerminkan (rencana acuan terkunci).

- **Yang menahan order sekarang (blocker):** Shadow dan/atau kill switch (dibuktikan oleh `execution_enabled=false`), ditambah session arm (status UNKNOWN).
- **Yang cuma bikin WAITING (filter strategi):** setup/trigger belum terpenuhi, Decision Gate belum READY, Risk belum APPROVED. Filter ini tetap aktif setelah blocker dilepas.
- **Approval manual per trade:** tidak ada di kode. Session arm itu satu file per sesi, bukan per trade.
- **XAUUSD + BTCUSD bersamaan:** boleh (maks 2 posisi, 2 simbol). Duplikat di simbol yang sama ditolak (1 posisi per simbol dikunci di kode, plus sinyal duplikat ditolak).
- **Saat gagal:** order/preflight gagal -> tercatat BLOCKED/REJECTED, tidak dicoba ulang otomatis. SL/TP hilang -> preflight menolak. Rekonsiliasi tidak cocok -> semua order baru diblokir, tersimpan walau restart. Fill sebagian/terlambat: ditangkap lewat sync deal history.

| Kemampuan | Ada di kode | Lulus tes simulasi | Terbukti di broker DEMO |
|---|---|---|---|
| Decision Gate + Risk 0,5% | Ya | Ya (82/82 sebelumnya) | Belum |
| Shadow memblokir + mencatat intent | Ya | Ya | UNKNOWN (catatan shadow di VPS belum dibaca) |
| Arm fail-closed | Ya | Ya | UNKNOWN |
| Kirim order + SL/TP | Ya | Ya (fake MT5) | **Belum ada satu pun** |
| Reconcile + blokir saat mismatch | Ya | Ya | Belum |
| Journal per tradeId | Ya | Ya | Belum |

## 3. Stabilitas Engine Host (hipotesis, belum terbukti)

Kandidat yang terlihat di kode (`engine-host/main.ts`):
- H1 SSE: `req.on("close")` di baris 324; broadcast tiap 2 detik ke semua klien (312-316) tanpa cek `write()` mengembalikan false. Kalau close tidak terpicu, koneksi mati bisa menumpuk di memori.
- H2 Baca ulang file penuh: chart snapshot (290) membaca dan parse seluruh `demo-events.jsonl` tiap 10 detik; endpoint evaluation juga. Beban naik seiring file membesar.
- H3 Timer yang saling tumpuk: execution-status 5s, outbox 10s, sync/poll 15s, reconcile 60s, tick. Kalau satu panggilan lambat, panggilan berikutnya bisa menumpuk.
- H4 Snapshot/persistensi paper dan history candle per runtime yang terus bertambah.

Cara membuktikan atau menolak (nanti, bukan sekarang): tes lokal yang membuka lalu memutus N klien SSE dan mengukur ukuran set `sse`; tes beban dengan `demo-events.jsonl` besar; dan data runtime minimal yang diperlukan: tren RAM/CPU proses dan jumlah koneksi ke 8090 dari waktu ke waktu, plus ukuran file `data/*.jsonl`. Tidak ada patch sebelum datanya cocok.

## 4. Isu yang bukan blocker inti

| Isu | Kelompok |
|---|---|
| Quote, candle, indikator, Radar, Analisis, SNR (XAU + BTC) | Sudah berfungsi (health 19:23 UTC: dua simbol ONLINE, jam broker NORMAL, latensi ~100 ms) |
| Lampu gateway "/v1/terminal 404" | Gangguan UI (perbaikan sudah ada, belum dipublish) |
| Status 8782 kadang timeout, cloud relay basi | Gangguan pemantauan |
| Quick Tunnel berganti URL | Gangguan pemantauan (diparkir) |
| Telegram, status-agent v3, secret | Belum dapat diverifikasi / diparkir |
| Shadow, kill switch, session arm | **Blocker auto-order** (disengaja) |
| Satu order DEMO end-to-end | Belum terbukti |

## 5. Blocker minimum untuk auto-order DEMO (setup, Gate, Risk tetap aktif)

1. Pastikan nilai runtime saat ini dari Shadow, kill switch, arm, commit, dan reconciliation (sekarang UNKNOWN karena `/execution-status` dan `/version` diblokir proxy).
2. Shadow CLEAR (env `EXECUTION_MODE=DEMO`, tanpa `SHADOW_MODE=ON`).
3. Kill switch dilepas (file, `emergency_stop`, halt dari cloud).
4. File session arm valid (mode DEMO, belum kedaluwarsa, hash akun ada di whitelist).
5. Reconciliation CLEAN, akun PASS, MT5 CONNECTED.
6. Engine stabil untuk sesi panjang (hipotesis bagian 3 sudah diuji).

## 6. Kontradiksi / asumsi yang belum selesai

- Yang membuat `execution_enabled=false` saat ini: Shadow, kill switch, atau keduanya. Belum diketahui.
- Commit yang berjalan di VPS belum terbukti sama dengan `83c752f`.
- Apakah `risk-policy.json` di VPS sama dengan repo.
- Apakah agent cloud (CONTROL_PLANE) aktif atau mode STANDALONE.
- Akar masalah timeout (H1–H4).

## 7. Urutan kerja berikutnya (tanpa BUILD)

1. Sepakati cara membaca runtime: menambahkan `/v1/engine/execution-status` dan `/version` yang sudah disaring ke allowlist proxy (keputusan dulu, belum dikerjakan), atau operator membaca baris log `[demo-arm]`/`[engine-host] build` di VPS.
2. Cocokkan nilai itu dengan tabel bagian 1, lalu tutup semua UNKNOWN.
3. Rancang tes untuk H1–H4 dan tentukan data runtime minimal yang dibutuhkan.
4. Baru setelah itu pilih SATU perubahan kecil (perbaikan stabilitas ATAU commissioning DEMO terkontrol), masing-masing dengan persetujuan terpisah.

## Konfirmasi

Tidak ada kode, konfigurasi, proses VPS, tunnel, secret, relay, atau order yang diubah. Yang dilakukan hanya membaca file repo dan tiga permintaan GET baca-saja ke tunnel yang sudah ada.
