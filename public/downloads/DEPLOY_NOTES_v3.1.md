# DEPLOY NOTES — bridge v3.1 (commit 7820854)

Paket: `arena-engine-host-deploy-bridge-v3.1-7820854.zip`
Basis: paket bridge v3 (b47942d) + delta v3.1 (session arm, tanpa konsep approval manual).
Commit final: `7820854` ("Added session arm v3.1") — merge commit yang menggabungkan `b47942d` (v3) dan `7c42917` (perubahan v3.1). Isi file `7820854` identik dengan `7c42917`; `7820854` adalah HEAD repo dan mencakup seluruh perubahan v3 + v3.1.
Checksum: lihat `SHA256SUMS_v3.1.txt` di samping zip.

## Status keamanan (LOCKED)

- EXECUTION_PERMISSION = FALSE (BUILD_INFO: `execution_permission:false`)
- SHADOW_MODE = ON (BUILD_INFO: `shadow_mode:true`)
- Tidak ada order test. `demo-arm.json` TIDAK disertakan — operator yang membuatnya di VPS.
- Tidak ada `.env`, token, atau data runtime (`engine-host/data/`) di dalam zip.
- Tanpa `demo-arm.json` yang valid: tahap maksimal DEMO_CONNECTED, reason `SESSION_ARM_REQUIRED`, tidak ada intent yang diteruskan ke bridge.

## Konsep: session arm, bukan approval per trade

Tidak ada approval manual per trade. Yang memutuskan adalah sistem:
Signal → Decision Gate → Risk Engine → Shadow Guard → **session arm** → DemoExecutionBridge → MT5 DEMO.
Session arm hanya menyatakan "sesi DEMO ini diaktifkan operator sampai waktu X". Setelah sesi aktif, engine berjalan otomatis. Session arm hanya bisa MENAHAN, tidak bisa melewati Decision Gate, Risk Engine, atau Shadow Guard.

## Perubahan v3.1 vs v3 (6 file runtime + 1 test + BUILD_INFO)

1. `src/core/enginehost/automationState.ts` — `USER_APPROVAL_MISSING` → `SESSION_ARM_REQUIRED`; checklist `USER_APPROVAL`/"User Approval" → `SESSION_ARM`/"Session Arm"; field `user_approval` (APPROVED/NOT_APPROVED) → `session_arm` (ARMED/NOT_ARMED).
2. `src/core/enginehost/demoArm.ts` — format arm file diperketat (lihat di bawah); alasan tolak baru `ARM_MODE_NOT_DEMO`.
3. `src/core/enginehost/EngineHost.ts` — rename opsi ke `sessionArmed` (perilaku sama).
4. `engine-host/main.ts` — teks log saja: `risk-approved open held: SESSION_ARM_REQUIRED`.
5. `src/components/ExecutionChecklist.tsx` — label "SESI BELUM DI-ARM".
6. `src/core/execution/demo/AGENTS.md` — aturan modul.
7. `src/test/automation-bridge-locked.test.ts` — nama baru.
8. `engine-host/BUILD_INFO.json` — commit 7820854.

Tidak berubah (byte-identik dengan v3): Signal Logic, Decision Gate, Risk Engine (`riskPolicy.ts`, `risk-policy.json`), Shadow Guard, DemoExecutionBridge/Layer, MT5 Gateway (`vps/`), LivePaperLoop, `install-windows.ps1`.

## Format `demo-arm.json` (dibuat operator, BUKAN bagian paket)

Lokasi: `engine-host/data/demo-arm.json`
```json
{ "armed": true, "mode": "DEMO", "expires_at": 1760400000000, "account_hash": "<sha256 hex dari login demo>" }
```
- `armed`: boolean `true` (teks `"true"` ditolak).
- `mode`: wajib `"DEMO"`; selain itu → `ARM_MODE_NOT_DEMO`.
- `expires_at`: epoch milidetik UTC; lewat → `ARM_EXPIRED`.
- `account_hash`: sha256 hex (huruf kecil) dari login demo yang ada di `DEMO_ACCOUNT_WHITELIST`; tidak cocok → `ARM_ACCOUNT_MISMATCH`.
- Field lama `account_login_hash` tidak diterima lagi → `ARM_FILE_INVALID`.
- Kill switch aktif → selalu `KILL_SWITCH`, apa pun isi file.
- Engine Host hanya MEMBACA file ini; tidak pernah membuat, memperpanjang, atau mengubahnya.

Hitung hash di PowerShell (login demo bukan secret, tapi jangan tempel token apa pun):
```powershell
$l = "<login demo>"; ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($l))) -replace '-','').ToLower()
```
Hitung expires_at (contoh 8 jam):
```powershell
[DateTimeOffset]::UtcNow.AddHours(8).ToUnixTimeMilliseconds()
```

## Backup sebelum ekstrak (WAJIB)

Kondisi VPS saat ini: engine aktif pada commit `7ddfd9d`.
1. Stop Engine Host (task `ArenaEngineHost`) dan MT5 Gateway (service port 8100).
2. Salin SELURUH folder engine/repo lama ke luar folder repo dengan nama bertanggal, mis. `C:\arena-backup\engine-7ddfd9d-2026-10-12\`.
3. Backup state runtime `engine-host\data\` (journal, snapshot, `automation-transitions.jsonl`, paper account) — zip tidak berisi data runtime dan tidak boleh menimpanya.
4. Catat lokasi rollback dan verifikasi backup bisa dibuka SEBELUM ekstrak.

## Rotasi token (WAJIB jika token pernah lewat tunnel/internet)

Port 8100 sempat terbuka lewat tunnel publik. Anggap `DEMO_EXEC_TOKEN` lama bocor:
1. Matikan tunnel ke port 8100 (8100 hanya loopback `127.0.0.1`).
2. Buat token baru acak ≥24 karakter (mis. `[Convert]::ToBase64String((1..32 | % {Get-Random -Max 256}) -as [byte[]])`) — jangan ditulis ke file repo, chat, atau log.
3. Set di PowerShell admin: `[Environment]::SetEnvironmentVariable('DEMO_EXEC_TOKEN','<token baru>','Machine')`.
4. Token yang SAMA dipakai MT5 Gateway dan Engine Host (keduanya membaca `DEMO_EXEC_TOKEN` dari environment Machine). Token tidak pernah masuk dashboard.

## Environment Machine-level (cek ada, JANGAN print nilai)

`EXECUTION_MODE=DEMO`, `ACCOUNT_MODE=DEMO`, `SHADOW_MODE=ON`, `DEMO_EXEC_URL=http://127.0.0.1:8100`, `DEMO_EXEC_TOKEN`, `DEMO_ACCOUNT_WHITELIST`, `DEMO_SERVER_WHITELIST`.
Cek tanpa nilai: `'EXECUTION_MODE','ACCOUNT_MODE','SHADOW_MODE','DEMO_EXEC_URL','DEMO_EXEC_TOKEN','DEMO_ACCOUNT_WHITELIST','DEMO_SERVER_WHITELIST' | % { "$_ = " + [bool][Environment]::GetEnvironmentVariable($_,'Machine') }`

## Urutan instalasi + restart (WAJIB, persis)

1. Backup (lihat atas), catat lokasi rollback.
2. Stop Engine Host.
3. Stop MT5 Gateway.
4. Rotasi token jika perlu, set/verifikasi env Machine-level.
5. Ekstrak zip menimpa folder repo (jangan hapus `engine-host\data\`).
6. Pastikan port 8100 hanya loopback, tunnel ke 8100 mati.
7. Jalankan `engine-host/install-windows.ps1` (elevated).
8. Start MT5 Gateway (`python -m vps.mt5_exec.server`, port 8100).
9. Start Engine Host.

Alasan urutan: proses hanya membaca environment Machine saat start. MT5 Gateway yang tidak di-restart tetap memakai token lama → Engine Host dapat 401 UNAUTHORIZED.

## Verifikasi di VPS

1. `curl http://127.0.0.1:8090/v1/engine/version` → commit `7820854`.
2. `curl http://127.0.0.1:8090/v1/engine/execution-status` → mode DEMO_EXECUTION, mt5 CONNECTED, account PASS, reconciliation CLEAN, stage DEMO_CONNECTED, reason `SESSION_ARM_REQUIRED`, `session_arm: NOT_ARMED`.
3. Arming sesi (keputusan operator, terpisah): buat `demo-arm.json` → phase WAITING_SETUP; log `[demo-arm] ARMED`.
4. Setup asli muncul → phase SIGNAL + shadow record; nol posisi MT5 selama SHADOW_MODE=ON.
5. Tahap B (SHADOW_MODE=OFF, order DEMO beneran) butuh keputusan eksplisit terpisah.

## Test (tidak termasuk runtime package)

- `src/test/demo-arm.test.ts` ada di source commit `7820854`, TIDAK di dalam zip; test dijalankan di build environment, bukan VPS.
- Hasil build environment: typecheck bersih, vitest 1109/1109 lulus.
- Bukti jalur DEMO hidup di VPS = isi `/v1/engine/execution-status` di mesin itu, bukan hasil test.

## Rollback

- Tutup sesi: hapus `engine-host/data/demo-arm.json` → kembali DEMO_CONNECTED (`SESSION_ARM_REQUIRED`), nol intent ke bridge, tanpa restart.
- Matikan jalur DEMO: set `EXECUTION_MODE=SHADOW`, restart Engine Host → MONITOR_ONLY/PAPER_READY.
- Darurat: buat file `engine-host/data/DEMO_KILL_SWITCH`.
- Penuh: stop Engine Host + MT5 Gateway, kembalikan folder backup `7ddfd9d`, start MT5 Gateway lalu Engine Host.
