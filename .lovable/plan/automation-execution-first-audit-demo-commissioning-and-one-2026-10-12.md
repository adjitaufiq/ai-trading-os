# Automation Execution First — Audit, DEMO Commissioning, and One Controlled Validation

## Objective

Membuktikan pipeline automation existing bekerja end-to-end pada akun MT5 DEMO sebelum mempertimbangkan Manual Test Mode.

```text
Market Data → Technical Engine → SNR / Market Structure → Signal Detection
→ Decision Gate → Risk Engine → Execution Permission → MT5 DEMO
→ Trade Journal → Post-Trade Analysis
```

Manual Test Mode, Human vs AI comparison, dan research dataset baru tetap **parked** sampai automation terbukti stabil.

## Non-negotiable Guardrails

- Jangan ubah strategy, technical calculation, SNR overlay, Decision Gate, risk calculation, SL/TP, Shadow Guard, reconciliation, atau order flow.
- Jangan redesign Engine Host atau dashboard.
- Akun REAL dan live trading tetap tidak memiliki jalur eksekusi.
- Jangan tampilkan token, secret, login penuh, atau identity sensitif.
- Jangan memanggil order endpoint sebelum approval eksplisit kedua.
- Jangan mengubah environment atau meng-arm DEMO sebelum approval eksplisit pertama.
- Missing, stale, atau mismatch tetap fail-closed (`UNKNOWN`/`BLOCKED`).
- Jika audit menemukan blocker yang memerlukan code change, stop, laporkan root cause dan perubahan minimum; tunggu approval terpisah.

## Verified Starting Point

Audit sebelumnya telah membuktikan:

- Engine Host build `83c752f` hidup; XAUUSD dan BTCUSD `ONLINE`, radar `ACTIVE`.
- Health melaporkan `MONITOR_ONLY`, `execution_enabled=false`, `demo_execution=REAL_DISABLED`.
- Execution status melaporkan `BLOCKED`, account/MT5 `UNKNOWN`, Shadow `BLOCKING`.
- Blockers: `EXECUTION_PERMISSION_DISABLED`, `SHADOW_GUARD_ACTIVE`.
- Dashboard menyalin status VPS dengan benar; bukan masalah cache atau URL lama.
- Demo executor adalah service loopback terpisah; route read-only `/v1/demo/*` tidak diekspos lewat tunnel Engine Host.
- Tidak ada broker-check-only mode: `order_check` langsung diteruskan ke `order_send` bila lolos. Karena itu tidak boleh membuat dummy order.

## Phase 1 — Automation Execution Audit (Read-only)

### 1. Engine Host

Periksa ulang dan catat timestamp:

- build/version;
- `GET /v1/engine/health`;
- `GET /v1/engine/execution-status`;
- `GET /v1/engine/readiness`;
- `GET /v1/engine/pipeline`;
- current mode, freshness, kill switch, reconciliation, Shadow Guard, dan blocker literal.

### 2. Runtime configuration

Audit environment milik proses Engine Host yang benar-benar berjalan, bukan hanya file konfigurasi:

- `EXECUTION_MODE`;
- `ACCOUNT_MODE`;
- `SHADOW_MODE`;
- `RISK_POLICY_FILE` exists dan valid;
- `DEMO_EXEC_URL` tersedia;
- `DEMO_EXEC_TOKEN` exists;
- login/server whitelist exists dan valid;
- `EMERGENCY_STOP` dan `DEMO_KILL_SWITCH` state;
- control-plane halt/config state bila agent digunakan.

Laporkan hanya `exists/missing`, `enabled/disabled`, dan `valid/invalid`.

### 3. Pipeline evidence before execution

Dari readiness, pipeline, journal, dan shadow records, verifikasi tanpa order:

- market data fresh;
- technical output tersedia;
- SNR/market structure tersedia sebagai evidence, tanpa dijadikan otoritas baru;
- signal lifecycle tercatat;
- Decision Gate outcome tercatat;
- Risk outcome tercatat ketika ada candidate;
- approved intent mencapai Shadow Guard ketika kondisi pasar alami memproduksinya;
- Shadow Guard mencegah broker send ketika blocking.

Jika belum ada setup alami, laporkan `WAITING FOR NATURAL SIGNAL`; jangan mengarang atau memaksa signal.

### Phase 1 exit criteria

PASS bila status dan konfigurasi runtime dapat dijelaskan konsisten, tidak ada stale/mismatch tersembunyi, dan seluruh safety layer terbukti tetap terpasang. Jika tidak PASS, stop dengan blocker list dan rekomendasi minimum.

## Phase 2 — MT5 DEMO Readiness (Read-only on VPS)

Dari loopback VPS dengan autentikasi lokal, periksa hanya:

- service `vps/mt5_exec` berjalan dan dijangkau Engine Host;
- `/v1/demo/account`;
- `/v1/demo/positions`;
- symbol status XAUUSD;
- symbol status BTCUSD.

Konfirmasi tanpa memaparkan identity:

- terminal adalah akun DEMO, bukan REAL;
- login/server cocok whitelist;
- balance dan equity valid;
- XAUUSD dan BTCUSD tersedia;
- posisi existing diketahui;
- executor dan read-only MT5 gateway tidak tertukar.

Jangan panggil `/v1/demo/orders`.

### Phase 2 exit criteria

PASS bila DEMO identity valid, kedua simbol tersedia, bridge dapat dijangkau, tidak ada posisi/reconciliation ambiguity, dan semua pemeriksaan read-only berhasil. Jika Phase 1 atau 2 tidak PASS, stop sebelum arming.

## Approval Gate 1 — Arm DEMO

Sebelum perubahan environment/service apa pun, kembalikan laporan Phase 1–2 dan minta approval eksplisit untuk controlled transition.

Rencana transisi minimum:

```text
MONITOR_ONLY + SHADOW BLOCKING
                 ↓
DEMO_EXECUTION + safety layers intact
```

Tidak ada perubahan kode kecuali blocker spesifik sudah disetujui.

## Phase 3 — Controlled DEMO Commissioning

Hanya setelah Approval Gate 1:

1. Backup konfigurasi/runtime state yang relevan dan catat rollback command.
2. Terapkan perubahan minimum pada environment process agar execution path DEMO ter-arm.
3. Pertahankan risk policy, whitelist, kill switch, Decision Gate, Shadow Guard implementation, reconciliation, dan journal tanpa perubahan.
4. Restart hanya service yang diperlukan dengan prosedur terkontrol.
5. Verifikasi ulang endpoint dan startup log.
6. Jika ada mismatch, account invalid, bridge error, kill switch, atau stale data: rollback/stop fail-closed.

### Expected commissioned idle state

- Engine: `ONLINE`.
- Mode: `DEMO_EXECUTION`.
- Account: `PASS` / checklist `CONNECTED`.
- MT5: `CONNECTED`.
- Shadow: `CLEAR`.
- Kill switch: `false`.
- Reconciliation: `CLEAN`.
- Execution: `WAITING_SIGNAL` ketika belum ada candidate valid.

**Contract clarification:** Risk dapat tetap `UNKNOWN` saat idle karena belum ada M4 attempt. `RISK=PASS` hanya sah untuk candidate fresh yang telah melewati Decision Gate dan M4. Jangan memalsukan `PASS` agar checklist tampak lengkap.

Checklist menyebut commissioned idle state sebagai **ARMED**; endpoint aktual menggunakan `WAITING_SIGNAL`, bukan enum `ARMED`.

## Approval Gate 2 — One Automated DEMO Order

Setelah commissioned idle state stabil dan seluruh status fresh, tampilkan:

- endpoint evidence;
- account/symbol validation yang disanitasi;
- reconciliation CLEAN;
- zero unexpected positions;
- current risk limits;
- rollback/kill-switch readiness.

Kemudian minta approval eksplisit sebelum sistem diizinkan menunggu/mengeksekusi satu order automation DEMO. Jangan membuat signal manual, dummy, atau bypass.

## Phase 4 — First End-to-End Automated DEMO Validation

Hanya setelah Approval Gate 2:

1. Tunggu **natural engine signal**; jangan inject BUY/SELL dan jangan melewati Decision Gate.
2. Bekukan evidence satu lifecycle berdasarkan `signalId`/`tradeId`.
3. Verifikasi urutan:

```text
Signal READY
→ Decision Gate ALLOW
→ Plan PLANNED
→ Risk M4 APPROVED
→ Execution Request
→ Shadow/safety preflight CLEAR
→ MT5 DEMO response
→ Position reconciliation
→ Journal record
```

4. Batasi validasi pada satu lifecycle/order DEMO.
5. Setelah hasil pertama tercatat, stop automation commissioning dan laporkan; jangan otomatis lanjut ke trade kedua.
6. Exit posisi hanya melalui mekanisme broker SL/TP existing; jangan menambah close/modify/manual route.
7. Verifikasi broker fill/reject, slippage/latency, reconciliation, journal, dan post-trade record. Jika posisi masih terbuka, laporkan lifecycle sampai `POSITION_OPEN`; post-trade analysis menunggu broker close tanpa memaksa penutupan.

### Phase 4 success criteria

- Satu signal alami memiliki trace lengkap dan tidak duplikat.
- Decision Gate dan Risk M4 benar-benar PASS untuk signal itu.
- Hanya akun DEMO whitelist yang menerima request.
- Broker response tercatat.
- Reconciliation tetap CLEAN.
- Journal memakai satu trade lifecycle identity.
- Setelah broker close, post-trade analysis menerima record yang lengkap.
- Tidak ada perubahan strategy/risk/execution semantics.

## Phase 5 — Stability Review and Manual Mode Parking

Setelah validasi pertama, nilai automation berdasarkan evidence, bukan profit/loss:

- status/freshness stabil;
- tidak ada duplicate send;
- restart/reconciliation aman;
- journal lengkap;
- post-trade record dapat dibaca Research Intelligence;
- blocker/reject reason dapat dijelaskan.

Manual Test Mode tetap parked sampai automation dinyatakan stabil dalam review terpisah. Scope masa depan—belum diimplementasikan:

```text
Human Entry → MT5 DEMO → Unified Journal
→ Market Snapshot → Post-Trade Analysis
```

Jika kelak disetujui, manual mode wajib memakai journal, analytics, dan market snapshot yang sama, tanpa menjadi bypass terhadap akun DEMO identity atau safety controls.

## Deliverables per checkpoint

### Setelah Phase 1–2

- PASS/FAIL per audit item;
- sanitized endpoint/runtime evidence;
- blocker list;
- pemeriksaan VPS yang belum terbukti;
- perubahan minimum yang diusulkan;
- stop dan tunggu Approval Gate 1.

### Setelah Phase 3

- commissioned idle status;
- rollback evidence;
- freshness/reconciliation evidence;
- stop dan tunggu Approval Gate 2.

### Setelah Phase 4

- trace satu lifecycle automation;
- MT5 DEMO result;
- journal/reconciliation result;
- post-trade status;
- unrelated findings hanya dilaporkan, tidak diperbaiki otomatis;
- stop tanpa memulai Manual Test Mode.
