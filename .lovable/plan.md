# Audit fallback RADAR_H4_STATE, lalu selesaikan scope PR (tanpa publish, tanpa zip final)

## Hasil audit fallback (dari code sekarang)

**1. Kenapa ada fallback?** Bukan karena ada kebutuhan di runtime. Ini sisa dari guard v0.5 pertama, yang dibuat sebelum `primaryBias` dikirim ke intent order. Saat itu `intent.context.h4Bias` satu-satunya data H4 yang tersedia.

**2. Apakah radar h4Bias sama dengan primaryBias?** Tidak.
- `intent.context.h4Bias` diisi dari `intelligence.h4_state` (`intent.ts`). Isinya teks struktur dari `MarketIntelligenceEngine.ts:91`, misalnya `"LH_LL"` atau `"HH_HL · BULLISH_MSS"`, bukan `"BULLISH"`/`"BEARISH"`.
- Akibatnya, cabang fallback `h4b === "BULLISH" | "BEARISH"` di `DemoExecutionBridge` praktis tidak pernah cocok. Fallback ini dead code.
- Hitungannya juga beda. Radar hanya memakai struktur, sedangkan `primaryBias` memakai struktur + EMA21/50 dari H4 yang sudah close (`operator.ts:414-446`). Keduanya tidak dijamin sepakat.

**3. Kapan primaryBias hilang?**
- `host.bundle(...).slice` bernilai null saat runtime belum ter-mount.
- Snapshot teknis UNAVAILABLE, misalnya market state atau quote tidak ada (`tradingState.ts:494-498`); `primary_bias` jadi `"NONE"`.
- H4 MIXED atau INSUFFICIENT juga menghasilkan `"NONE"`.
- Dalam ketiga kasus itu radar masih bisa punya `h4_state`, tapi formatnya tidak pernah lolos fallback (lihat nomor 2).

**4. Apakah menghapus fallback memutus alur yang sah?**
- Fallback-nya sendiri: tidak, karena tidak pernah aktif.
- Yang perlu lo putuskan: fail-closed saat `primaryBias` NONE atau tidak ada akan memblokir order. Ini berlaku juga saat paper loop menghasilkan READY tapi H4 operator MIXED.
- Sebabnya, arah order demo saat ini datang dari jalur M1B→M2→M3→M4 di `LivePaperLoop`. Arah H4 di jalur itu dihitung sendiri oleh `computeBiasState`, yang hanya memakai struktur dari bar CLOSED (`LivePaperLoop.ts:179,208`), bukan dari `operatorAnalysis`.
- Jadi fail-closed adalah perilaku baru yang disengaja: tanpa arah utama H4 yang authoritative, tidak ada order. Ini sesuai invariant.

**5. Jalur code yang sebenarnya:**
```text
Arah order:
  H4 CLOSED bars -> LivePaperLoop.visible() (status CLOSED, close_time <= bar)
  -> computeBiasState (M1B, struktur saja) -> M2 setup -> M3 plan -> M4 risk
  -> ApprovedPaperOpen.direction

Primary bias authoritative:
  H4 CLOSED bars (TechnicalSliceService: CLOSED + available_at <= asOf)
  -> operatorAnalysis.primary_bias (struktur + EMA H4)
  -> evaluate() snapshot.primary_bias
  -> host.bundle().slice.current (engine-host/main.ts:133)
  -> buildDemoIntent context.primaryBias
  -> DemoExecutionBridge guard (sebelum cek akun dan sebelum order)
```
Catatan risiko arsitektur: ada dua penghitung arah H4 (M1B di paper loop, operator di slice). Guard di bridge menyatukan keduanya di titik eksekusi. Menyamakan sumber arah di paper loop di luar scope; ini hanya dilaporkan.

## Usulan perubahan
- **Hapus fallback radar.** Guard hanya membaca `context.primaryBias`.
- **primaryBias BUY/SELL tapi sisi order berlawanan:** blok dengan `BLOCKED_COUNTER_PRIMARY_BIAS`, isi audit tetap sama, source `TECHNICAL_H4_CLOSED`.
- **primaryBias NONE atau tidak ada:** fail-closed, tanpa order. Nama alasan blokir menunggu keputusan lo:
  - **Opsi A (rekomendasi):** pakai ulang `BLOCKED_COUNTER_PRIMARY_BIAS` dengan detail `primaryBias=UNAVAILABLE`. Tidak ada istilah baru, tapi labelnya kurang tepat.
  - **Opsi B:** tambah satu alasan, `PRIMARY_BIAS_UNAVAILABLE`. Lebih jujur di laporan dan Telegram.
  - Alasan blokir demo yang sudah ada tidak ada yang cocok: `INVALID_PLAN` artinya plan tidak valid, `IDENTITY_UNAVAILABLE` urusan akun.
- **Test:** radar `h4Bias` terisi + `primaryBias` tidak ada → BLOCKED tanpa order. `primaryBias` NONE → BLOCKED tanpa order.

## Sisa scope yang tetap jalan
1. **Item 1:** pastikan rename ke `BLOCKED_COUNTER_PRIMARY_BIAS` sudah di semua tempat (code, test, AGENTS.md, Telegram).
2. **Item 2:** test audit dua sisi: BUY saat SELL, dan SELL saat BUY.
3. **Item 3:** test bahwa event BLOCKED demo memetakan isi audit ke `timeframe_context` dan `block_reason`, dan alert Telegram menampilkan block_reason.
4. **Item 4:** test eksplisit di `operatorAnalysis`/`evaluate`:
   - candle H4 yang masih berjalan dan naik tajam tidak membalik `primary_bias` SELL, dan tidak ada plan BUY;
   - setelah H4 berikutnya benar-benar close dan membalik struktur, baru `primary_bias` boleh berubah;
   - bar FORMING atau bar dengan `available_at > asOf` tidak masuk input H4.
5. **Verifikasi:** test terkait, typecheck penuh (`tsgo`), dan seluruh suite. Kegagalan di luar scope hanya dicatat.

Tidak rebuild zip VPS final dan tidak publish. AGENTS.md teknis diperbarui supaya mencatat guard hanya membaca primaryBias dan fail-closed.
