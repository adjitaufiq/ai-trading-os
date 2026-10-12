# Engine Host & MT5 Demo Execution — Read-only Audit and Commissioning Checklist

## Objective

Memastikan execution path siap untuk DEMO tanpa merusak perilaku fail-closed. Tahap pertama hanya audit dan laporan temuan; tidak ada perubahan kode, konfigurasi, service, execution, atau deploy.

## Constraints

- Jangan desain ulang Engine Host.
- Jangan ubah logika Decision Gate.
- Jangan hapus atau melemahkan Shadow Guard.
- Jangan aktifkan live/real trading.
- Cakupan hanya validasi kesiapan DEMO execution.
- Jangan memanggil endpoint order.
- Jangan menampilkan secret atau identity lengkap.
- Jangan mengubah kode sebelum blocker spesifik ditemukan dan disetujui terpisah.

## Current Baseline

Kondisi yang sudah terverifikasi dari Engine Host saat ini:

- Engine: `ONLINE`.
- Mode: `MONITOR_ONLY`.
- Execution: `BLOCKED`.
- Account: `UNKNOWN`.
- MT5: `UNKNOWN`.
- Shadow: `BLOCKING`.
- Blockers: `EXECUTION_PERMISSION_DISABLED`, `SHADOW_GUARD_ACTIVE`.

## Phase 1 — Running Environment State Audit

Audit state lingkungan milik proses Engine Host yang benar-benar berjalan, bukan hanya isi file konfigurasi:

- `EXECUTION_MODE`
- `SHADOW_MODE`
- `ACCOUNT_MODE`
- `RISK_POLICY_FILE`
- ketersediaan `DEMO_EXEC_TOKEN`
- konfigurasi MT5 bridge
- whitelist login dan server
- kill-switch files/state yang relevan

Target kesiapan DEMO:

- `EXECUTION_MODE=DEMO`
- `ACCOUNT_MODE=DEMO`
- `SHADOW_MODE=OFF`

Jangan tampilkan nilai secret. Laporkan hanya:

- ada / tidak ada;
- aktif / nonaktif;
- valid / tidak valid.

## Phase 2 — Engine Host Execution Status Verification

Verifikasi:

- `GET /v1/engine/health`
- `GET /v1/engine/execution-status`
- startup log dari proses Engine Host aktif

Tentukan penyebab pasti `DemoExecutionBridge` belum ARMED. Cocokkan response dengan environment runtime, risk policy, token, whitelist, kill switch, control-plane state bila digunakan, dan reconciliation.

Target DEMO commissioning:

- Mode: `DEMO_EXECUTION`.
- Execution: `ARMED`.
- Account: `CONNECTED`.
- MT5: `CONNECTED`.
- Shadow: `CLEAR`.

Untuk pelaporan, `ARMED` berarti jalur DEMO sudah aman dan siap menunggu setup; nilai endpoint aktual dapat berupa `WAITING_SIGNAL` sebelum ada Decision Gate + Risk PASS. Account `CONNECTED` dipetakan dari endpoint `account=PASS`.

## Phase 3 — MT5 DEMO Bridge Read-only Audit

Verifikasi hanya endpoint read-only dari VPS:

- `/v1/demo/account`
- `/v1/demo/positions`
- status simbol XAUUSD
- status simbol BTCUSD

Konfirmasi:

- terminal MT5 menggunakan akun DEMO, bukan REAL;
- identity login dan server cocok dengan whitelist;
- account, balance, dan equity tersedia;
- XAUUSD dan BTCUSD tersedia;
- bridge dapat dijangkau oleh Engine Host.

Jangan panggil endpoint eksekusi order. Semua output harus disanitasi; cukup laporkan kecocokan identity, bukan nilainya.

## Phase 4 — Shadow Guard Review

Tinjau Shadow Guard tanpa menghapus atau mengubahnya:

- Verifikasi `SHADOW_MODE=ON` memang memblokir order.
- Verifikasi approved intent dicatat sebelum dihentikan.
- Verifikasi gateway wrapper tidak meneruskan `sendOrder` saat shadow aktif.
- Verifikasi guard safety lain tetap aktif.

Setelah seluruh audit lulus, siapkan rencana transisi terkontrol:

```text
MONITOR_ONLY + SHADOW BLOCKING
                 ↓
DEMO_EXECUTION + EXECUTION ARMED
```

Jangan jalankan transisi sebelum ada persetujuan eksplisit terpisah.

## Phase 5 — Safe Execution Flow Validation

Jangan membuat dummy order dan jangan memanggil broker order endpoint.

Validasi jalur aman yang sudah ada:

```text
Paper path:
Signal → Decision Gate → Risk Check → Paper execution

Shadow path:
Approved intent → Shadow Guard → Block confirmation
```

Konfirmasi melalui readiness, pipeline events, journal, dan shadow records bahwa:

- signal generation berfungsi;
- Decision Gate menghasilkan outcome tercatat;
- Risk layer menghasilkan outcome tercatat;
- approved intent dapat mencapai Shadow Guard;
- Shadow Guard memblokir execution;
- tidak ada order request yang diteruskan ke MT5;
- tidak ada posisi baru yang dibuka.

## Phase 6 — Final Readiness Report

Kembalikan laporan berikut:

- Engine: `ONLINE / OFFLINE`.
- Market XAUUSD: `READY / NOT READY`.
- Market BTCUSD: `READY / NOT READY`.
- MT5 Demo: `CONNECTED / NOT CONNECTED`.
- Execution: `BLOCKED / ARMED`.
- Account: `CONNECTED / NOT CONNECTED / UNKNOWN`.
- Risk: `PASS / BLOCKED / UNKNOWN`.
- Reconciliation: `CLEAN / MISMATCH / UNKNOWN`.
- Shadow: `CLEAR / BLOCKING`.
- Remaining blockers: daftar literal dan evidence sumbernya.
- Pemeriksaan yang masih harus dilakukan langsung di VPS.

## Success Criteria

Sistem dinyatakan siap DEMO execution bila seluruh kondisi berikut terbukti:

- ENGINE `ONLINE`.
- MODE `DEMO_EXECUTION`.
- ACCOUNT `CONNECTED`.
- MT5 `CONNECTED`.
- RISK `PASS`.
- RECONCILIATION `CLEAN`.
- SHADOW `CLEAR`.
- EXECUTION `ARMED`.

Sebelum ada setup valid, commissioning state yang diharapkan pada endpoint adalah `WAITING_SIGNAL`; ini dilaporkan sebagai `ARMED` pada checklist. Audit tidak membuka posisi dan tidak mencoba mencapai `ACTIVE`.

## Deliverable First

Kembalikan temuan audit per fase terlebih dahulu, dengan:

- response endpoint yang disanitasi;
- evidence file dan baris;
- blocker list;
- status PASS/FAIL tiap fase;
- daftar validasi VPS yang belum terbukti.

Tidak ada build besar atau perubahan kode pada tahap ini. Jika ditemukan blocker spesifik, laporkan dan tunggu approval sebelum perubahan apa pun.
