# DEPLOY NOTES — Engine Host 93819c7 (MT5 Demo Bridge, LOCKED)

## Build
- Commit: 93819c7635d11bc2bc2db3ac008e6855ec5595d2 ("Dibangun Bridge MT5 & Checklist")
- Baseline VPS sebelumnya: engine-host-v1.2 (7ddfd9d) — paket ini menggantikannya.
- Mode: LOCKED. EXECUTION_PERMISSION tetap FALSE, SHADOW_MODE aktif, tidak ada auto order.

## Isi paket
- Full source dari commit 93819c7 (552 file), termasuk engine-host/, src/, vps/mt5_exec/, package.json, vite.config.
- BUILD_INFO.json — commit + timestamp build.
- CHANGED_FILES.txt — daftar 56 file berubah vs baseline bae9120.

## Perubahan utama vs paket v3 (83c752f)
1. Endpoint baru di service MT5 VPS (port 8100): GET /v1/demo/status dan GET /v1/demo/symbols, plus data margin di status akun.
2. State machine bertahap: MONITOR_ONLY → PAPER_READY → DEMO_CONNECTED → DEMO_ARMED → DEMO_EXECUTION (src/core/enginehost/automationState.ts).
3. Snapshot chart audit saat entry/close (src/core/execution/demo/chartSnapshot.ts) — metadata event di setiap titik.
4. Field jurnal DEMO dilengkapi: timeframe, setup, zona SNR. Confidence = tidak tersedia (tidak dikarang).
5. Panel checklist eksekusi di dashboard (ExecutionChecklist): Engine ONLINE, Market Data Fresh, SNR Available, Decision Gate PASS, Risk PASS, MT5 DEMO Connected, Account Verified, Shadow Guard Cleared, User Approval. Satu gagal → EXECUTION BLOCKED.

## Yang TIDAK berubah
- Decision Gate, Shadow Guard, risk engine, alur order, SL/TP — tidak disentuh.
- Tidak ada jalur order baru; tombol User Approval belum ada (bridge tetap terkunci).

## Instalasi di VPS
1. Backup: cp -r /path/engine-host /path/engine-host-backup-$(date +%Y%m%d)
2. Unzip paket ke folder baru: unzip arena-engine-host-deploy-93819c7.zip -d engine-host-93819c7
3. cd engine-host-93819c7 && bun install
4. Salin .env dari instalasi lama (paket tidak menyertakan .env).
5. Restart service engine-host (systemd/pm2 sesuai setup lo).
6. Restart service MT5 demo executor: python -m vps.mt5_exec.server (port 8100).

## Health check setelah deploy
- curl http://127.0.0.1:8765/v1/engine/health → operating_mode harus MONITOR_ONLY, execution_enabled false.
- curl http://127.0.0.1:8765/v1/engine/execution-status → 200, permission BLOCKED.
- curl -H "X-Demo-Token: $DEMO_EXEC_TOKEN" http://127.0.0.1:8100/v1/demo/status → MT5 CONNECTED/DISCONNECTED + margin.
- curl -H "X-Demo-Token: $DEMO_EXEC_TOKEN" "http://127.0.0.1:8100/v1/demo/symbols?symbols=XAUUSD,BTCUSD" → availability.

## Rollback
1. Stop service engine-host.
2. Kembalikan folder backup: engine-host-backup-YYYYMMDD.
3. Restart service. Verifikasi /v1/engine/health kembali normal.

## Validasi sebelum paket dibuat
- Full test suite: 1107/1107 PASS (2 timeout awal lolos saat diulang).
- Typecheck: PASS.
