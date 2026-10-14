# Laporan READ-ONLY — Status-Agent v3: artefak, secret, dampak runtime

Tidak ada perubahan, build, publish, instalasi, atau order. Bukti diambil langsung dari `public/downloads/status-agent-deploy-v3.zip` (SHA-256 `ef0458af46718e7685a398067752240868e654ce2638b7b6be9a3dce8c8fb785`, cocok) dan source.

## 1. Isi ZIP — PASS
- Installer: `install-status-agent.ps1` (BUKAN `install.ps1` — instruksi terakhir saya salah).
- README: `README_WINDOWS.md`. Lainnya: `run-status-agent.ps1`, `uninstall-status-agent.ps1`, `status_agent/agent.py`, `tests/test_status_agent.py`.
- Nama task: `ArenaStatusAgent` (BUKAN `ArenaEngineStatusAgent` — juga salah di instruksi terakhir).
- Cara jalan: task AtStartup sebagai SYSTEM → `run-status-agent.ps1` (loop supervisor, restart 30 s) → `python -m status_agent.agent`. Installer: copy → unit test → satu `--once` push; task hanya didaftarkan jika push = 200.

## 2. Nama secret — PASS: `ENGINE_STATUS_AGENT_SECRET`
- Agent: `status_agent/agent.py` `main()` membaca `ENGINE_STATUS_AGENT_SECRET` (+ opsional `STATUS_RELAY_URL`, `STATUS_AGENT_ID`, `STATUS_PUSH_INTERVAL_S`). Installer/runner membacanya dari env **Machine**.
- Backend: `src/routes/api/public/agent/engine-status.ts` memverifikasi dengan `process.env.ENGINE_STATUS_AGENT_SECRET`.
- Instruksi `EXECUTION_AGENT_SECRET` dari saya **SALAH**. Jangan set.

## 3. Bukan secret eksekusi — PASS
- `EXECUTION_AGENT_SECRET` adalah secret terpisah milik control plane eksekusi: dipakai `engine-host/main.ts` (pull config, push events) dan `src/lib/control/agentAuth.server.ts` (`/api/public/agent/config|heartbeat|events`).
- `ENGINE_STATUS_AGENT_SECRET` hanya dipakai route `engine-status` yang menulis snapshot allowlist ke `engine_status_relay`. Tidak ada jalur config/arm/order. Menukar keduanya justru berisiko → jangan dicampur.

## 4. Penyebab push=401 — UNKNOWN (paling mungkin secret tidak cocok)
- Tes production barusan: POST tanpa tanda tangan dengan `User-Agent: ArenaStatusAgent/2` → **401 dari relay** (lolos Cloudflare; artinya fix User-Agent bekerja, 403 sudah hilang).
- Format signature agent = backend (`ts\nPOST\npath\nbody`, HMAC-SHA256 hex, ±5 menit) — dicek tes `test_signature_matches_backend_canonical`. Backend production sudah menerima format ini.
- Jadi 401 pada VPS berarti salah satu: (a) nilai Machine env VPS ≠ secret backend, (b) env kosong/dibaca dari scope User bukan Machine, (c) jam VPS melenceng > 5 menit. Tidak bisa dipastikan dari sini tanpa melihat nilai → UNKNOWN.
- Respons harapan saat benar: `push=200 engine=ONLINE phase=... reachable=True`, lalu task terdaftar.
- Cek aman di VPS (tanpa menampilkan nilai): `[bool][Environment]::GetEnvironmentVariable("ENGINE_STATUS_AGENT_SECRET","Machine")`, `w32tm /query /status`. Jika secret tidak cocok, solusi aman: generate ulang secret status di backend lalu set nilai yang sama di VPS — hanya setelah Anda setujui.

## 5. Menggantikan tunnel 8782? — FAIL (belum, dengan konfigurasi sekarang)
- Dashboard (`src/hooks/use-relay-status.ts`): jika `VITE_ENGINE_STATUS_URL` diisi, browser langsung memanggil `<tunnel 8782>/v1/public/engine-status`; relay cloud `/api/public/engine-status` hanya dipakai bila variabel itu kosong. Saat ini terisi → dashboard tetap bergantung 8782 walau agent terpasang.
- Telegram (`src/lib/engineStatus/relay.server.ts` `syncRelayHealth`): menarik 8782 lalu membaca baris terbaru `engine_status_relay` (sumber mana pun). Dengan agent aktif, Telegram akan sehat walau 8782 timeout — sebagian menggantikan.
- Relay production sekarang: `status ONLINE`, heartbeat umur ~98 s — berasal dari pull 8782 (`status-proxy-8782`), bukan agent.
- Pensiun 8782 hanya aman setelah: agent push 200 stabil ≥24 jam, lalu (perubahan terpisah, butuh approval) mengosongkan `VITE_ENGINE_STATUS_URL` + publish agar dashboard membaca relay cloud, verifikasi, baru matikan tunnel.

## 6. Batas fungsi agent — PASS
- Hanya membaca `127.0.0.1:8090` (health + execution-status) dan mengirim heartbeat tersaring tiap 15 s. Tidak menulis ke Engine Host, tidak restart, tidak ada jalur order.
- Jika 8090 timeout, agent hanya melapor `engine_reachable=false / OFFLINE`. **Tidak** memperbaiki timeout HTTP, CPU, atau kebocoran memori SSE — itu pekerjaan kode terpisah di `engine-host/main.ts`.

## Koreksi instruksi saya sebelumnya
| Instruksi lama | Yang benar |
|---|---|
| `EXECUTION_AGENT_SECRET` | `ENGINE_STATUS_AGENT_SECRET` (Machine) |
| `install.ps1` | `install-status-agent.ps1` |
| task `ArenaEngineStatusAgent` | `ArenaStatusAgent` |

## Langkah berikut (menunggu persetujuan Anda, belum dikerjakan)
1. VPS baca-saja: cek keberadaan env Machine + sinkron jam.
2. Bila perlu: rotasi secret status (backend + VPS) — hanya status, tidak menyentuh `EXECUTION_AGENT_SECRET`.
3. Install agent setelah push 200; pantau ≥24 jam.
4. Perubahan terpisah: dashboard pindah ke relay cloud, lalu pensiun 8782.
5. Terpisah: diagnosis + patch SSE Engine Host.

Kill switch dan Shadow tetap aktif.
