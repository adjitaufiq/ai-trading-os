# Audit backlog project (read-only, belum ada code yang diubah)

Sumber: isi code, roadmap.md, AGENTS.md per folder, dan query langsung ke database. Kalimat yang ditandai *inferensi* belum terbukti langsung.

## ALREADY DONE

- **M4 Risk Engine & Execution Guard.** Tidak ada definisi M4 di roadmap.md atau MASTER_ARCHITECTURE.md. Satu-satunya sumber resmi ada di `src/engine/risk/AGENTS.md:1` dan `src/engine/risk/types.ts:1-3`.
  - **Tujuan:** menilai TradePlan dari M3. Yang dicek: lot dibulatkan ke bawah sesuai step, budget risiko, kondisi akun dan cooldown, exposure, margin, spread, dan slippage. Hasilnya keputusan beku APPROVED/WARNING/BLOCKED dengan audit `executable:false, orderSent:false, MONITOR_ONLY`. M4 tidak pernah mengubah plan dan tidak pernah menyentuh broker; eksekusi milik M5.
  - **Dependency:** M1B.1–M1B.11 → M2 SignalSetup → M3 evaluator/plan → **M4** → M5 paper (buka posisi hanya kalau M4 APPROVED) → M6 journal. Rantai ini disusun di `LivePaperLoop`.
  - **Yang sudah ada:** `riskEngine.ts`, `positionSizer.ts`, `exposureGuard.ts`, `executionGuard.ts`, `riskGuard.ts`, `accountState.ts`, dan 28 unit test di 4 file.
  - **Yang belum ada:** dokumen acceptance resmi, test integrasi M3→M4→M5 di folder risk, dan entri M4 di roadmap.md.
  - **Acceptance yang diharapkan** (diturunkan dari aturannya): plan tidak pernah berubah; budget/margin/spread/slippage/cooldown/exposure masing-masing menghasilkan BlockReason yang tepat; lot di bawah minimum → BLOCKED; hasil selalu MONITOR_ONLY dan beku.
  - Executor demo memakai `calculatePositionSize` dari M4 plus guard demo sendiri. Ini lapisan terpisah dan tidak mengubah M4.
- **Dua temuan keamanan kritis engine_memory/engine_trades: sudah tertutup.** Database saat ini:
  - Proteksi baris aktif di tabel engine_memory, engine_trades, dan trade_reviews.
  - Tiap tabel hanya punya satu aturan baca: user login yang `is_engine_operator(auth.uid())`. Tidak ada aturan tulis.
  - Pengunjung tanpa login tidak punya akses sama sekali.
  - Ada trigger yang menolak UPDATE/DELETE, dan setiap INSERT dicatat di `engine_access_audit`.
  - Hasil scan keamanan tersimpan tidak menunjukkan temuan, tapi sudah basi. Yang perlu: jalankan scan ulang untuk mengonfirmasi, lalu tandai fixed. Fix tambahan tidak perlu.
- **Phase 5A/5B** (`src/lib/review/compliance.ts`, `performance.ts`, beserta tesnya): sudah live. *Inferensi:* label 5A/5B hanya muncul di judul commit, bukan di dokumen.
- **M1B.8 Institutional Footprint Radar:** selesai (roadmap.md:38), bukti pasif saja.
- **Header MONITOR_ONLY:** perubahannya hanya label/tampilan. Teks dan tombol yang di-disable cuma memantulkan `execution.state`, `EXECUTION_ENABLED`, dan `operating_mode`; tidak ada nilai yang dibaca balik oleh engine. Rekomendasi: **KEEP**, karena label yang memisahkan AI MONITOR_ONLY dari DEMO executor membuat tampilan lebih jujur dan sesuai arsitektur.
- **BLOCKED_COUNTER_PRIMARY_BIAS di code:** rename, detail audit, wiring ke riwayat event, dan Telegram sudah ada. Satu test di level executor lulus.

## CAN DO NOW (tanpa VPS)

1. **Test eksplisit persistence H4 primaryBias.** Pengamannya sudah ada: `TechnicalSliceService.ts:91` dan `mergeClosedHistory` hanya mengambil candle CLOSED dengan `available_at <= asOf`. Tes yang ada (`technical-probe-v1c.test.ts:128-140`, `d2-runtime.test.ts:272`) menguji lapisan probe/runtime, bukan `operatorAnalysis` dan `primary_bias`. Celahnya: belum ada test yang membuktikan candle H4 yang masih berjalan tidak bisa membalik `primary_bias`, dan hanya H4 baru yang sudah close yang boleh mengubahnya. Isinya cuma test, logic tidak diubah.
2. **Scan keamanan ulang**, lalu tandai dua temuan RLS sebagai fixed kalau hasilnya bersih.
3. **D1 dan D3 (utang audit Patch B):** audit source plus test. D1: pastikan hanya kasus fingerprint sama tapi identity beda yang berubah ke AMBIGUOUS_COLLISION, sedangkan raw_event_id yang sama tetap EXACT_TRANSPORT_DUPLICATE. D3: urutan drain deterministik dan bukan klaim urutan pasar. Bisa dikerjakan di codebase, tapi menurut roadmap butuh instruksi eksplisit lo.
4. **Rapikan roadmap.md:** tambah entri M-pipeline (M4 selesai, M8 diblokir) dan tandai item yang sudah obsolete (lihat di bawah).

## NEEDS VPS

- **Deploy engine-host terbaru.** Ini syarat untuk tiga hal: `counter_trend_condition` muncul di live, event BLOCKED_COUNTER_PRIMARY_BIAS masuk ke cloud dan Telegram, dan executor membaca `primaryBias` dari hasil analisa teknis.
- **Heartbeat/failover.** Yang sudah ada: heartbeat bertanda tangan dari VPS (`agentSync.ts:49-59`), config gagal-tertutup kalau umurnya lebih dari 60 detik, ENGINE_OFFLINE/ONLINE dari capture cloud tiap 5 menit, dan fallback dashboard ke BROWSER SESSION. Celahnya: route heartbeat tidak pernah menandai agent offline, dan offline baru ketahuan lewat capture 5 menit. Perlu VPS baru untuk diuji end-to-end.
- **Bukti end-to-end demo trade:** order masuk, lalu journal, lalu EXIT.
- **MARKET_DATA.TICK vs TICKS.** Bridge Python sudah mengirim `TICKS` yang benar. Stream live masih mengirim alias `TICK`, dan client menerimanya hanya di frame LIVE sambil menghitung jumlahnya. Perbaikannya di gateway Windows (vps/mt5_gateway), bukan di dashboard.

## NEEDS EXTERNAL REAL DATA

- **G2 broker-time offset:** belum terselesaikan, terlihat dari penanda `BROKER_SERVER_TIME_UNRESOLVED_G2` di `TechnicalSliceService.ts:38`. Perlu observasi offset dari broker nyata; tidak boleh diperbaiki dengan menebak offset.
- **Validasi data nyata v1b:** diblokir G2 dan butuh gateway nyata.
- **Audit integrasi penuh PRE-2D + audit sumber independen:** diblokir sampai lo kasih instruksi eksplisit. Sebaiknya dikerjakan setelah G2 dan v1b, supaya auditnya mencakup data nyata.
- **M8 Optimization Laboratory:** belum ada code. Diblokir oleh verifikasi M1B.8 dari lo, dan butuh dataset trade demo yang cukup.

## OBSOLETE (perlu ditutup di roadmap)

- **"TRADE/ANALYSIS technical cards still computed in the browser"** (roadmap.md:44): sudah tidak berlaku sejak Phase 2.1. Host sekarang menghitung hasil analisa teknis per simbol, dan browser hanya menghitung sendiri di mode BROWSER SESSION.
- **"Install on VPS + second tunnel + set VITE_ENGINE_HOST_URL"** (roadmap.md:43): sudah dilakukan sebelumnya. Yang tersisa hanya update versi, sudah masuk NEEDS VPS.
- **"Real Vertical Slice v1 ... tunnel NXDOMAIN"** dan **"Canonical unification ... WS 404"**: alasan tunnel/WS sudah tidak berlaku karena dashboard live sudah ter-mount. Yang masih memblokir hanya G2, jadi tulis ulang alasan blokirnya.

## Rekomendasi urutan kerja

1. **Scan keamanan ulang dan tandai RLS fixed.** Murah dan menutup risiko keamanan paling atas.
2. **Test eksplisit persistence H4 primaryBias.** Cuma test, tanpa ubah logic, dan mengunci aturan yang baru dideploy sebelum VPS jalan versi baru.
3. **Rapikan roadmap.md.** Status M4/M8 jadi tercatat, item obsolete ditutup.
4. **Deploy VPS engine-host terbaru** (dijalankan oleh lo). Setelah itu verifikasi `counter_trend_condition`, event BLOCKED di cloud dan Telegram, lalu bukti demo trade end-to-end.
5. **Heartbeat/failover**, setelah runtime VPS stabil.
6. **D1/D3 dan audit PRE-2D**, menunggu instruksi eksplisit lo.
7. **G2 lalu v1b**, saat data broker nyata bisa diobservasi.
8. **M8**, setelah M1B.8 diverifikasi dan dataset demo cukup.
