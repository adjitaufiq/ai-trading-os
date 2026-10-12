# Opsi 1: Jalur EXECUTION_MODE=DEMO, validasi pipeline end-to-end

## Dua konflik yang harus diputuskan dulu

1. **SHADOW_MODE=ON vs "DEMO EXECUTION".** Kalau Shadow Guard aktif, order nggak bisa sampai ke MT5. Pipeline cuma bisa jalan sampai `Execution Bridge → Shadow Guard → BLOCK (tercatat)`. Jadi validasi dibagi dua tahap:
   - **Tahap A (SHADOW ON):** Market → Signal → Decision Gate → Risk → Bridge → Shadow record → Journal (status SHADOW_BLOCKED). Nggak ada order ke broker.
   - **Tahap B (SHADOW OFF, butuh approval eksplisit terpisah):** order DEMO beneran → MT5 DEMO → close dari broker → Journal.
2. **"Tanpa approval manual per trade."** Sekarang `USER_APPROVAL` selalu NOT_APPROVED, jadi stage DEMO_ARMED nggak akan pernah tercapai. Solusinya **satu kali arming di level sesi** dari system gate, bukan approval per trade: file `demo-arm.json` di VPS (dibuat operator, ada masa berlaku, dibaca saja oleh Engine Host). Nggak ada tombol arming di dashboard dan nggak ada jalur tulis dari web.

## Perubahan kode (kecil, BUILD terpisah)

1. **Arming dari system gate**: `userApproved()` di `engine-host/main.ts` baca `engine-host/data/demo-arm.json` (`{armed:true, expires_at, account_login_hash}`). Arming nggak berlaku (fail-closed) kalau file nggak ada, sudah kedaluwarsa, akunnya nggak cocok, atau kill switch aktif. Engine Host nggak pernah menulis file ini.
2. **Nama stage disamakan dengan target** (cuma label, gate tetap sama):
   ```text
   MONITOR_ONLY → DEMO_CONNECTED → WAITING_SETUP (=DEMO_ARMED, execution WAITING_SIGNAL)
   → SIGNAL (execution READY) → DEMO_EXECUTION (posisi terbuka / shadow record) → JOURNAL (trade tertutup tercatat)
   ```
   Kalau SHADOW ON, stage maksimal yang dilaporkan `WAITING_SETUP`/`SIGNAL` + `SHADOW_BLOCKED`. Stage ini nggak pernah dilaporkan ARMED palsu.
3. **`install-windows.ps1`**: tambah `EXECUTION_MODE`, `ACCOUNT_MODE`, `SHADOW_MODE`, `DEMO_EXEC_URL`, dan `DEMO_EXEC_TOKEN`. Nilainya diambil dari env Machine-level VPS dan nggak ditulis literal di file.
4. **Test**: arming kedaluwarsa atau tidak ada → DEMO_CONNECTED; SHADOW ON → nol panggilan `sendOrder`; arming valid + READY → intent sampai ke bridge.

Yang nggak diubah: Decision Gate, Risk Engine, Shadow Guard, aturan risk di `risk-policy.json`, dan sinyal.

## Langkah deploy paling kecil (setelah BUILD)

1. Bikin paket `bridge-only v3` = v2 + 4 perubahan di atas.
2. Di VPS: stop Engine Host lama (`7ddfd9d`), lalu ekstrak paket.
3. Set env persistent (Machine): `EXECUTION_MODE=DEMO`, `ACCOUNT_MODE=DEMO`, `SHADOW_MODE=ON`, `DEMO_EXEC_URL=http://127.0.0.1:8100`, `DEMO_EXEC_TOKEN` (nilainya sama dengan yang dipakai gateway), whitelist login/server.
4. Restart MT5 Gateway (8100, cuma loopback, tunnel ke 8100 dimatikan), lalu jalankan ulang `install-windows.ps1`.
5. Cek `/v1/engine/execution-status`: mode DEMO_EXECUTION, mt5 CONNECTED, account PASS, reconciliation CLEAN, stage DEMO_CONNECTED, reason USER_APPROVAL_MISSING.
6. Operator bikin `demo-arm.json`, lalu stage harus jadi WAITING_SETUP.
7. Tunggu satu setup asli. Harus ada urutan READY → shadow record → journal SHADOW_BLOCKED, dan nol posisi baru di MT5.
8. Tahap B (SHADOW OFF) baru jalan setelah approval eksplisit terpisah.

## Rollback
Hapus `demo-arm.json`, atau set `EXECUTION_MODE=SHADOW`, lalu restart. Engine Host langsung balik ke MONITOR_ONLY.
