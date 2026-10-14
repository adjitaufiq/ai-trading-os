# Audit Insiden (read-only): Engine Host 8090 menerima koneksi tetapi HTTP timeout

Hanya audit. Tidak ada perubahan kode/config, build, publish, restart, tunnel, atau order.

## 1. Cara request diproses (fakta dari source `engine-host/main.ts`, `src/core/enginehost/api.ts`)

- Server: satu `node:http` `createServer` di `127.0.0.1:8090`, berjalan di Bun, **satu thread JavaScript (event loop)**. Tidak ada worker, lock, mutex, atau queue eksplisit.
- `/v1/engine/health` -> `routeEngineRequest` -> `host.health()`: hanya menyalin state dalam memori (`deriveSymbolHealth`, build info, shadow status). Tidak ada `await`, tidak ada disk I/O, tidak memanggil gateway 8765/8100. Health **ringan dan tidak bergantung pada snapshot/radar** secara logika.
- Tetapi karena satu event loop, health **hanya bisa dibalas kalau event loop tidak sedang terblokir**. Apa pun yang memblokir loop akan membuat semua route (health, snapshot, snr) diam bersamaan — persis gejala yang dilaporkan.
- `/v1/engine/snapshot` dan `/v1/analysis/snr/*` lebih berat (bundle per simbol, kalkulasi SNR) tetapi tetap sinkron dan dalam memori.

## 2. Operasi sinkron/blocking yang ada di proses yang sama (fakta source)

| Lokasi | Interval | Operasi |
|---|---|---|
| chart snapshot (baris ~290) | 10 s | `readFileSync` **seluruh** `demo-events.jsonl` + JSON.parse tiap baris + bisa `writeFileSync` SVG |
| `pushOutbox` (baris ~211) | 10 s **dan setiap pipeline event** | `readFileSync` **seluruh** `engine-events.outbox.jsonl` lalu split; file append-only, tak pernah dipangkas |
| `onPipelineEvent` | per event | `appendFileSync` outbox |
| executionStatus observer (baris ~281) | 5 s | readiness semua simbol + `snrPayload` per simbol |
| SSE broadcaster (baris ~312) | 2 s | `buildEngineEvents` + `r.write()` ke setiap subscriber tanpa cek backpressure |
| persistSlot (EngineHost.tick) | 5 s | `writeFileSync` + `renameSync` snapshot per simbol |
| slice tick | 2 s | evaluasi teknikal per simbol |
| `/v1/journal/trades`, `/v1/evaluation/*` | per request | baca seluruh `demo-events.jsonl` |
| `log()` | sering | tulis ke console jendela Bun |

Tidak ditemukan `execSync`/`spawnSync`, loop tanpa akhir yang jelas, atau deadlock berbasis lock (tidak ada lock).

## 3. Kenapa socket LISTEN/connect berhasil tapi tidak ada response

TCP accept dilakukan oleh OS (backlog kernel), bukan JavaScript. Jadi `connect` sukses walaupun event loop beku; byte HTTP tidak pernah dibaca/dibalas -> curl timeout. Ini konsisten dengan **event loop terblokir atau proses ter-suspend**, bukan masalah port/tunnel.

## 4. Kandidat penyebab (urut keyakinan, bukan angka)

1. **Keyakinan tinggi (perlu verifikasi) — Windows console QuickEdit/selection membekukan proses.** Jika jendela Bun pernah diklik/diseleksi, Windows menahan penulisan stdout; `log()` sinkron lalu memblokir seluruh event loop. Gejala khas: CPU ~0%, port LISTEN, semua HTTP diam, judul jendela diawali "Select". Menekan Enter/Esc di jendela akan melepas. (Perlu konfirmasi bahwa `log` menulis ke console — sangat mungkin, belum dicek baris definisinya.)
2. **Keyakinan sedang — pertumbuhan file append-only.** Outbox dan `demo-events.jsonl` dibaca utuh secara sinkron tiap 10 s (outbox juga tiap event). Jika file sudah besar, loop makin lama terblokir; gejala: CPU tinggi terus, memori naik, response kadang lambat lalu total timeout. 13 s response status-proxy sebelumnya konsisten dengan degradasi bertahap.
3. **Keyakinan sedang-rendah — SSE tanpa backpressure.** Subscriber SSE yang lambat/macet (mis. tunnel lama) membuat buffer `write()` menumpuk di memori; dapat memicu GC berat/memori tinggi. Tidak terbukti ada subscriber.
4. **Keyakinan rendah — proses mati/digantikan.** Jika PID 6248 mati, biasanya connect ditolak, bukan timeout — kecuali proses lain/zombie memegang port. Belum terverifikasi.
5. **Keyakinan rendah — await gateway yang menggantung.** Fetch ke gateway/control plane bersifat async dan tidak memblokir loop; kecil kemungkinan penyebab freeze total.

## 5. Peran proxy 8780 / 8782

- Proxy hanya GET dengan timeout 5 s; satu-dua request tiap poll **bukan** beban berarti untuk server sehat.
- Saat loop beku, request menumpuk di backlog OS dan akan diproses sekaligus ketika loop pulih -> lonjakan singkat. Bisa memperburuk, **tidak bukti penyebab**.
- `/v1/engine/snapshot` lewat proxy lebih berat daripada health; poll snapshot yang sering menambah kerja sinkron.

## 6. Tidak dapat diaudit tanpa runtime VPS

PID hidup/tidak, CPU/memori/thread aktual, isi log jendela Bun, ukuran file data, status QuickEdit, jumlah koneksi ESTABLISHED, posisi DEMO terbuka dan SL/TP di MT5.

## 7. Urutan diagnosis Windows (baca-saja, risiko terkecil dulu)

Ganti `<DATA_DIR>` dengan folder data Engine Host. Jangan tempel output yang berisi command line, token, login akun.

```powershell
# A. Siapa pemilik port 8090 sekarang
Get-NetTCPConnection -LocalPort 8090 | Select-Object LocalAddress,LocalPort,State,OwningProcess
# B. Proses itu: hidup? CPU/memori/thread/handle
$p = (Get-NetTCPConnection -LocalPort 8090 -State Listen).OwningProcess
Get-Process -Id $p | Select-Object Id,ProcessName,StartTime,CPU,WorkingSet64,PrivateMemorySize64,HandleCount,@{n='Threads';e={$_.Threads.Count}},Responding
# C. Ulangi B setelah 10 detik: CPU naik = loop sibuk; CPU tetap = loop beku/suspend
Start-Sleep 10; Get-Process -Id $p | Select-Object CPU,WorkingSet64
# D. Koneksi yang menumpuk ke 8090 (backlog/SSE)
Get-NetTCPConnection -LocalPort 8090 | Group-Object State | Select-Object Name,Count
# E. Ukuran file append-only (tanpa membaca isi)
Get-ChildItem <DATA_DIR> -File | Sort-Object Length -Descending | Select-Object Name,@{n='MB';e={[math]::Round($_.Length/1MB,2)}},LastWriteTime
# F. Tes HTTP langsung, timeout eksplisit
curl.exe --noproxy "*" -m 10 -s -o NUL -w "%{http_code} %{time_total}\n" http://127.0.0.1:8090/v1/engine/health
```

G. Lihat jendela Bun secara visual: apakah judul diawali "Select"/"Pilih"? Baris log terakhir & jamnya? (Laporkan saja, jangan menekan tombol dulu jika ingin bukti murni.)

Interpretasi cepat:
- CPU ~tetap + judul "Select" -> kandidat 1. Menekan Esc melepas tanpa restart (bukan restart, tetapi tetap perubahan state — putuskan sendiri).
- CPU terus naik + file outbox/demo-events besar + memori tinggi -> kandidat 2/3.
- Proses tidak ada / PID beda -> kandidat 4.

## 8. Jika nanti restart dipertimbangkan (tidak dilakukan di audit ini)

Syarat aman sebelum restart:
1. Di MT5 terminal DEMO: catat semua posisi terbuka, pastikan **setiap posisi punya SL dan TP di server broker** (bukan hanya di engine).
2. Pastikan tidak ada pending order tanpa SL.
3. Catat ukuran file data dan baris log terakhir (bukti forensik hilang setelah restart).
4. Pertimbangkan disarm DEMO dulu agar restart tidak langsung memicu entry baru saat state re-bootstrap.
5. Setelah restart, reconcile (startup + 60 s) harus cocok dengan posisi MT5 sebelum dipercaya.

## Checklist

**FAKTA**
- Satu event loop; semua route berbagi loop yang sama.
- Health murni dalam memori, tanpa I/O/await.
- Banyak `readFileSync` utuh atas file append-only setiap 5–10 s dan per event.
- SSE write tanpa backpressure.
- Timeout terjadi di `127.0.0.1`, jadi tunnel bukan penyebab.

**BELUM DIKETAHUI**
- PID/proses aktual, CPU/memori, QuickEdit, ukuran file, log terakhir, jumlah koneksi, posisi DEMO + SL/TP.

**LANGKAH BERIKUTNYA**
1. Jalankan perintah A–G, kirim hasil (tersamarkan).
2. Sementara itu cek MT5 langsung: posisi DEMO dan SL/TP, karena engine tidak bisa dipantau.
3. Berdasarkan hasil, baru diputuskan: lepas QuickEdit, atau rencana perbaikan (BUILD terpisah, butuh persetujuan) seperti baca-file inkremental, pemangkasan outbox, dan backpressure SSE.
