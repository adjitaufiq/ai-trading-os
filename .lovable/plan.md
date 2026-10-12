# Audit final: Engine Host, Dashboard, Shadow Guard, dan Permission

**Status: PASS untuk perilaku fail-closed.** Dashboard menampilkan fakta yang benar dari VPS saat ini. Respons live pada 12 Oct 2026 sekitar 09:31 UTC menunjukkan build `83c752f`, engine XAUUSD/BTCUSD `ONLINE`, tetapi mode `MONITOR_ONLY`, Shadow Guard aktif, account/MT5 `UNKNOWN`, dan execution `BLOCKED`.

Tidak ada kode, konfigurasi, flag, execution, atau deploy yang diubah.

## 1. Engine Host

### Respons VPS saat audit

- `GET /v1/engine/health` → HTTP 200:
  - `operating_mode: MONITOR_ONLY`
  - `execution_enabled: false`
  - `demo_execution: REAL_DISABLED`
  - build `engine-host-v1.2`, commit `83c752f`
  - XAUUSD dan BTCUSD `ONLINE`, radar `ACTIVE`
  - Shadow Guard `active: true`, label `SHADOW — NO ORDERS`
- `GET /v1/engine/execution-status` → HTTP 200:
  - `engine: ONLINE`
  - `mode: MONITOR_ONLY`
  - `execution: BLOCKED`
  - `account: UNKNOWN`, `mt5: UNKNOWN`
  - `shadow: BLOCKING`, `kill_switch: false`
  - blockers: `EXECUTION_PERMISSION_DISABLED`, `SHADOW_GUARD_ACTIVE`

### Sumber response

- Route health: `src/core/enginehost/api.ts:28` memanggil `host.health()`.
- Route execution status: `src/core/enginehost/api.ts:29-32` hanya memanggil `host.executionStatus(now)`.
- Health memilih `DEMO` hanya ketika demo bridge benar-benar armed; selain itu `MONITOR_ONLY`: `src/core/enginehost/EngineHost.ts:185-195`.
- Execution status menyalin arm state, Shadow Guard, kill switch, demo status, reconciliation, dan readiness: `src/core/enginehost/EngineHost.ts:202-219`.
- `account` dan `mt5` sengaja `UNKNOWN` saat host tidak armed: `src/core/enginehost/executionStatus.ts:58-67`.
- Status akun berasal dari `DemoExecutionBridge.status().account`: `src/core/execution/demo/DemoExecutionBridge.ts:170-185`.
- MT5 bukan health ping tersendiri; `CONNECTED` disimpulkan dari account identity demo yang valid. Saat demo bridge tidak dibuat, datanya tidak ada dan hasilnya `UNKNOWN`.
- Control-plane execution agent dibuat hanya jika URL dan secret control plane tersedia: `engine-host/main.ts:142-149`. Identitas/konektivitas agent **tidak menjadi field** di dua endpoint tersebut; hanya efek `agent.current().halted` yang masuk kill switch melalui `engine-host/main.ts:231-243`.

**Kesimpulan:** account/MT5 `UNKNOWN` bukan karena engine market mati. Demo execution bridge tidak armed, sehingga host sengaja tidak mengklaim akun atau koneksi execution.

## 2. Dashboard

- URL host berasal dari `VITE_ENGINE_HOST_URL`: `src/core/enginehost/client.ts:109-114`.
- Endpoint yang dipakai:
  - health: `src/core/enginehost/client.ts:78`
  - execution status: `src/core/enginehost/client.ts:79`
  - SSE: `src/core/enginehost/client.ts:102`
- Dashboard bootstrap membaca health + snapshot, lalu membuka SSE dan mengambil execution status: `src/lib/engineHostStore.ts:83-100`.
- Execution status diperbarui saat health SSE masuk dan setiap watchdog 5 detik: `src/lib/engineHostStore.ts:123-139,142-152`.
- Fetch gagal langsung menghapus execution status, sehingga nilai lama tidak bisa tetap hijau: `src/lib/engineHostStore.ts:132-139`.
- Lampu EXE hanya membaca `/v1/engine/execution-status`; `MONITOR_ONLY` atau `BLOCKED` selalu merah, dan data lebih dari 30 detik tidak boleh hijau: `src/lib/exeLamp.ts:17-33`.
- Wiring UI: `src/routes/index.tsx:74-76`.

Tidak ada localStorage, sessionStorage, IndexedDB, atau service worker untuk status Engine Host. URL tersimpan sebagai literal saat dashboard dibuild; risiko URL lama hanya jika browser/CDN masih menyajikan bundle dashboard lama. Namun respons live yang diperiksa sekarang persis sama dengan status dashboard, jadi penyebab saat ini **bukan cache/URL lama**.

## 3. Shadow Guard

Shadow Guard bukan monitoring saja. Ia memblokir order secara nyata pada dua lapis:

- Intent gate mengembalikan `allow: false` saat shadow aktif: `src/core/execution/shadow/ShadowGuard.ts:136-151`.
- Gateway wrapper mencegah pemanggilan `sendOrder`: `src/core/execution/shadow/ShadowGuard.ts:179-190`.
- Flag dibaca dari `EXECUTION_MODE`; default/non-DEMO menjadi SHADOW. `SHADOW_MODE=ON` selalu memaksa shadow aktif: `src/core/execution/shadow/ShadowGuard.ts:36-44` dan `src/core/execution/demo/DemoExecutionLayer.ts:12-17`.
- Host membaca hasil tersebut pada startup: `engine-host/main.ts:93-103`.

Pada VPS saat audit, health melaporkan `SHADOW — NO ORDERS`, sehingga Shadow Guard memang sedang memblokir.

## 4. Permission gate

- `EXECUTION_PERMISSION_DISABLED` dihasilkan oleh projection status saat mode `MONITOR_ONLY`: `src/core/enginehost/executionStatus.ts:56,86-94`.
- Mode menjadi `DEMO_EXECUTION` hanya jika `armed === true`.
- `armed` berarti objek `DemoExecutionBridge` berhasil dibuat: `engine-host/main.ts:132-200,238-242`.
- Bridge hanya dibuat saat `resolveExecutionPathMode(env) === DEMO`: `engine-host/main.ts:105-108,135-141`.
- Startup DEMO juga mensyaratkan:
  - `risk-policy.json` valid dan tersedia: `engine-host/main.ts:80-89,136-138`
  - `DEMO_EXEC_TOKEN`: `engine-host/main.ts:138-139`
  - login/server whitelist tidak kosong: `engine-host/main.ts:139-141`
- Agar permission aman, bukan sekadar armed, juga perlu Shadow Guard clear, kill switch off, account PASS, MT5 CONNECTED, reconciliation CLEAN, engine tidak offline, dan data tidak stale: `src/core/enginehost/executionStatus.ts:96-108`.
- `READY` selanjutnya memerlukan readiness fresh dengan Decision Gate M2 PASS dan Risk M4 PASS: `src/core/enginehost/executionStatus.ts:72-82,100-108`.

**Flag utama untuk ARMED adalah `EXECUTION_MODE=DEMO`** (legacy `DEMO_STRESS_TEST` juga diterima). Audit ini tidak mengubah flag tersebut. `SHADOW_MODE=OFF` bukan flag pemberi akses; hanya `SHADOW_MODE=ON` yang punya efek sebagai pemaksa blokir.

## 5. Jalur dummy order

**Tidak ada jalur dummy end-to-end ke MT5 yang berhenti aman setelah broker check.**

Jalur produksi yang tersedia adalah:

1. Signal READY dan Decision Gate ALLOW: `src/core/paper/LivePaperLoop.ts:362-384`.
2. Plan dan Risk M4 APPROVED: `src/core/paper/LivePaperLoop.ts:389-415`.
3. Approved open event: `src/core/paper/LivePaperLoop.ts:440-445`.
4. Engine Host membangun intent lalu melewati Shadow Guard: `engine-host/main.ts:244-250`.
5. Demo bridge/layer melakukan preflight dan request: `src/core/execution/demo/DemoExecutionLayer.ts:94-137`.
6. Gateway POST ke `/v1/demo/orders`: `src/core/execution/demo/gatewayClient.ts:50-55`.
7. MT5 service menjalankan `order_check`, lalu langsung `order_send` jika check lolos: `vps/mt5_exec/service.py:135-145`.

Pilihan aman yang sudah ada:

- Paper path menguji Signal → Decision Gate → Risk tanpa menyentuh MT5.
- Shadow path menguji approved intent sampai gerbang execution dan mencatat alasan blokir, tetapi tidak mencapai MT5 bridge.
- Unit/integration tests memakai fake MT5, bukan terminal VPS nyata.

Karena `order_check` tidak diekspos sebagai endpoint terpisah dan langsung diikuti `order_send`, tidak ada safe dummy request yang membuktikan seluruh jalur sampai MT5 tanpa risiko membuka posisi demo.

## Yang masih perlu dicek langsung di VPS

1. Environment milik **proses Engine Host yang benar-benar berjalan**, bukan hanya isi file konfigurasi:
   - `EXECUTION_MODE`
   - `SHADOW_MODE`
   - `ACCOUNT_MODE`
   - lokasi `RISK_POLICY_FILE`
   - keberadaan token serta whitelist tanpa memperlihatkan nilai rahasia.
2. Startup log proses: cari apakah muncul `EXECUTION_MODE=DEMO armed` atau justru mode SHADOW, serta apakah control plane `STANDALONE`/terhubung.
3. Service `vps/mt5_exec` di loopback port 8100 dan respons read-only `/v1/demo/account`, `/v1/demo/positions`, serta symbol endpoint menggunakan token lokal. Jangan panggil `/v1/demo/orders`.
4. Identitas terminal harus DEMO dan cocok dengan whitelist login/server.
5. File kill switch di `ENGINE_DATA_DIR`: `EMERGENCY_STOP` dan `DEMO_KILL_SWITCH`.
6. Record reconciliation terakhir di `reconcile-events.jsonl`; ketika DEMO belum armed, dashboard memang melaporkan `UNKNOWN`.
7. Jika control plane digunakan: heartbeat agent terbaru, `halted`, allowed symbols, dan konfigurasi cloud yang ditarik. Kedua endpoint Engine Host saat ini tidak memperlihatkan kesehatan agent secara eksplisit.

## Kesimpulan

Dashboard tidak salah baca. Root cause yang didukung response live adalah Engine Host berjalan tanpa demo bridge armed: `MONITOR_ONLY` + Shadow Guard aktif. Akibat langsungnya account dan MT5 tidak diprobe oleh status execution, lalu permission projection menghasilkan `EXECUTION_PERMISSION_DISABLED` dan `SHADOW_GUARD_ACTIVE`. Tidak ada safe full-chain dummy order menuju MT5; validasi tanpa posisi harus berhenti di paper/shadow atau memakai test doubles.
