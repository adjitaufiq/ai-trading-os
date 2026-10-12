# Post-SNR Overlay: Engine Host & MT5 Demo Commissioning Audit

## Objective

Audit read-only kondisi execution pipeline yang sedang berjalan, lalu siapkan commissioning DEMO secara fail-closed. Tahap pertama hanya menghasilkan temuan; tidak mengubah kode, konfigurasi, flag, service, atau membuka posisi.

## Guardrails

- Jangan redesign Engine Host.
- Jangan ubah strategy, Decision Gate, risk calculation, SL/TP, Shadow Guard, atau jalur order.
- Jangan mengaktifkan live/real trading; kapabilitas real tetap tidak ada.
- Jangan memanggil `/v1/demo/orders`.
- Jangan menampilkan token, secret, login penuh, atau data sensitif.
- Jangan mengubah flag sampai blocker spesifik terbukti dan ada approval terpisah.
- Setiap data hilang, stale, atau tidak konsisten tetap `UNKNOWN`/`BLOCKED`, tidak boleh diasumsikan aman.

## Current verified baseline

Respons live Engine Host build `83c752f` saat audit:

- Engine XAUUSD dan BTCUSD: `ONLINE`, radar `ACTIVE`.
- Health: `operating_mode=MONITOR_ONLY`, `execution_enabled=false`, `demo_execution=REAL_DISABLED`.
- Execution status: `mode=MONITOR_ONLY`, `execution=BLOCKED`, `account=UNKNOWN`, `mt5=UNKNOWN`, `shadow=BLOCKING`.
- Blockers: `EXECUTION_PERMISSION_DISABLED`, `SHADOW_GUARD_ACTIVE`.
- Kill switch dilaporkan `false`.

Baseline ini menunjukkan host market hidup, tetapi `DemoExecutionBridge` belum armed. Dashboard menyalin status tersebut dari endpoint Engine Host; belum ada bukti masalah cache atau URL lama.

## Phase 1 — Running Environment Audit

Periksa environment milik proses Engine Host yang benar-benar aktif, bukan hanya file konfigurasi:

- `EXECUTION_MODE`
- `SHADOW_MODE`
- `ACCOUNT_MODE`
- `RISK_POLICY_FILE`
- keberadaan `DEMO_EXEC_TOKEN`
- keberadaan whitelist login/server
- `DEMO_EXEC_URL`
- konfigurasi control-plane agent bila digunakan
- file `EMERGENCY_STOP` dan `DEMO_KILL_SWITCH`

Laporkan hanya `exists/missing`, `enabled/disabled`, atau `valid/invalid`. Jangan tampilkan nilainya.

**Catatan kontrak aktual:** `EXECUTION_MODE=DEMO` adalah flag pemberi arm. `ACCOUNT_MODE` otomatis dipaksa ke DEMO pada mode tersebut. `SHADOW_MODE=ON` memaksa blokir; nilai `OFF` tidak memberi akses tambahan dan tidak diperlukan untuk arm.

## Phase 2 — Engine Host Status Verification

Periksa ulang:

- `GET /v1/engine/health`
- `GET /v1/engine/execution-status`
- startup log Engine Host

Tentukan alasan persis `DemoExecutionBridge` tidak dibuat atau gagal armed. Cocokkan response dengan environment dan startup log, termasuk risk policy, token, whitelist, kill switch, control plane, dan reconciliation.

Gunakan state kontrak aktual:

- Health mode: `MONITOR_ONLY` atau `DEMO`.
- Execution mode: `MONITOR_ONLY` atau `DEMO_EXECUTION`.
- Account: `PASS`, `FAIL`, atau `UNKNOWN`.
- MT5: `CONNECTED`, `DISCONNECTED`, atau `UNKNOWN`.
- Permission: `BLOCKED`, `UNKNOWN`, `WAITING_SIGNAL`, `READY`, atau `ACTIVE`.

`ARMED` dipakai sebagai istilah commissioning, bukan nilai literal endpoint. Kondisi armed tetapi belum ada setup yang benar adalah `mode=DEMO_EXECUTION` dan `execution=WAITING_SIGNAL`.

## Phase 3 — MT5 Demo Bridge Read-only Audit

Dari loopback VPS dan menggunakan autentikasi lokal tanpa menampilkan secret, periksa hanya endpoint read-only:

- `/v1/demo/account`
- `/v1/demo/positions`
- symbol status untuk XAUUSD dan BTCUSD

Konfirmasi:

- terminal terhubung ke akun DEMO, bukan REAL;
- identity login/server cocok dengan whitelist;
- balance dan equity tersedia;
- XAUUSD dan BTCUSD tersedia pada demo executor;
- service `vps/mt5_exec` dapat dijangkau dari Engine Host.

Jangan panggil endpoint order. Jika account identity tidak valid atau bridge tidak dapat dijangkau, commissioning berhenti dalam keadaan blocked.

## Phase 4 — Shadow Guard and Safety Review

Buktikan perilaku saat ini tanpa menonaktifkannya:

- Shadow aktif menghasilkan `SHADOW_GUARD_ACTIVE`.
- Intent yang approved dicatat tetapi diblokir sebelum broker send.
- Gateway wrapper tetap mencegah `sendOrder`.
- Duplicate, SL/TP, emergency stop, max position, max symbol, dan daily trade guard tetap aktif.

Setelah semua audit PASS, siapkan perubahan konfigurasi minimum sebagai rekomendasi saja. Jangan menerapkannya tanpa approval terpisah. Target commissioning adalah `EXECUTION_MODE=DEMO`, Shadow Guard `CLEAR`, dan seluruh safety gate tetap terpasang.

## Phase 5 — Safe Flow Validation

Jangan membuat dummy order baru karena tidak ada broker-check-only endpoint. Validasi menggunakan jalur aman yang sudah ada:

```text
Paper:
Signal → Decision Gate → Plan → Risk Check → Paper Execution

Shadow:
Approved Intent → Shadow Guard → Block Record
```

Buktikan dari event/journal/readiness bahwa:

- signal lifecycle berjalan;
- Decision Gate menghasilkan hasil yang tercatat;
- risk layer menghasilkan M4 outcome;
- approved intent mencapai Shadow Guard;
- Shadow Guard memblokir tanpa request ke `/v1/demo/orders`;
- tidak ada posisi baru di MT5.

`order_check` tidak boleh dipakai sebagai dummy mode karena implementasi saat ini langsung melanjutkan ke `order_send` saat check lolos.

## Phase 6 — Final Readiness Report

Laporkan matriks berikut beserta evidence waktu dan sumbernya:

- Engine: `ONLINE / DEGRADED / OFFLINE`
- XAUUSD market/radar: `READY / NOT READY`
- BTCUSD market/radar: `READY / NOT READY`
- Demo account: `PASS / FAIL / UNKNOWN`
- MT5 execution bridge: `CONNECTED / DISCONNECTED / UNKNOWN`
- Shadow Guard: `CLEAR / BLOCKING`
- Kill switch: `OFF / ON`
- Reconciliation: `CLEAN / MISMATCH / UNKNOWN`
- Risk/readiness: `PASS / BLOCKED / UNKNOWN`
- Execution permission: `BLOCKED / UNKNOWN / WAITING_SIGNAL / READY / ACTIVE`
- Remaining blockers: daftar literal dari `/v1/engine/execution-status`

## Success Criteria

Commissioning dinyatakan **DEMO ARMED, WAITING SIGNAL** hanya jika:

- Engine `ONLINE`.
- Mode `DEMO_EXECUTION`.
- Account `PASS`.
- MT5 `CONNECTED`.
- Shadow `CLEAR`.
- Kill switch `false`.
- Reconciliation `CLEAN`.
- Data tidak stale.
- Execution `WAITING_SIGNAL` ketika belum ada setup valid.

Execution menjadi `READY` hanya ketika ada readiness fresh dengan Decision Gate M2 `PASS` dan Risk M4 `PASS`. `ACTIVE` hanya ketika posisi demo benar-benar terbuka; tahap audit ini tidak mencapainya.

## Stop Conditions

Stop dan laporkan tanpa perubahan bila ditemukan salah satu dari berikut:

- account REAL atau identity tidak cocok whitelist;
- token/risk policy/whitelist hilang atau invalid;
- bridge tidak terjangkau;
- kill switch aktif;
- reconciliation mismatch/unknown pada tahap arm;
- data stale;
- jalur aman membutuhkan pemanggilan order endpoint;
- konfigurasi aktual berbeda dari startup process environment.

## Deliverable Tahap Pertama

Audit findings per phase dengan file/line evidence, response endpoint yang sudah disanitasi, blocker list, dan daftar pemeriksaan VPS yang belum dapat dibuktikan. Tidak ada perubahan kode atau konfigurasi sampai blocker spesifik direview dan disetujui terpisah.
