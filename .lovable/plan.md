# Audit read-only: Market Intelligence vs Execution Profiles

Laporan audit saja. Tidak ada kode yang diubah, tidak ada tes yang dijalankan, dan tidak ada usulan perubahan kode. Laporan ini juga tidak memberi sinyal BUY/SELL.

## 1. Alur yang ada sekarang (dari bukti kode)

```text
MT5 VPS -> BrokerGatewayClient -> BrokerFeedPipeline (LIVE_MUTATION) -> fanout M5/M15/H1/H4 (CandleAggregator, hanya CLOSED)
        \-> BACKFILL history (seedBrokerHistory, store terpisah)
                         |
                   MarketRuntime (satu per simbol)
     +-------------------+----------------------------+
     | ARENA (core/technical)                         | M1B (engine/core) di LivePaperLoop
     | TechnicalSliceService.evaluateAt(asOf)         | swing/structure/bias/location/EMA/reaction
     | operatorAnalysis: H4 trend -> primaryBias      | -> createSetup -> READY
     | zona, regime, momentum scalp, plan acuan       |      ^ gate M2: primaryBias (fail closed)
     +--------------+---------------------------------+------+
                    | primaryBias                     M3 plan -> M4 risk -> paper open -> journal M6
                    v                                          |
             Radar/UI/AI (hanya membaca)              ApprovedPaperOpen -> buildDemoIntent -> DemoExecutionBridge -> VPS :8100
```

Faktanya ada dua mesin analisis. ARENA menentukan arah. M1B menentukan setup, entry, SL/TP, dan apa yang dicatat di journal. Belum ada lapisan "Execution Profile".

## 2. Tabel kemampuan

| Kemampuan | Status | Lokasi | Bukti | Risiko / gap |
|---|---|---|---|---|
| Multi-timeframe, hanya candle CLOSED | Tersedia dan teruji | `CandleAggregator`, `TechnicalSliceService.evaluateAt`, `h4-forming-boundary.test.ts` | Tes C1–C3 menolak bar FORMING, bar dengan `available_at > asOf`, dan bar dengan `close_time > asOf` | ARENA dan M1B menggabungkan data history dengan data live secara terpisah (`MarketRuntime.ts:162`) |
| Swing tanpa look-ahead | Tersedia dan teruji | `indicators.ts:91 causalSwings`, `swingDetector.ts:39` | Tie-rule B, tes `pivot-tie-rule`/`tieRule`, `confirmedAt` = close bar kanan ke-2 | Ada dua detektor swing. Aturannya sudah diseragamkan, tapi bukti yang dibaca tetap berbeda |
| Trend dan struktur | Tersedia dan teruji (H4) | `operator.ts:44,132`; M1B `structureEngine`, `biasEngine` | Rumusnya eksplisit: AND biner antara EMA21/50 dan HH_HL/LH_LL | Ada dua definisi bias. Journal M1B bisa mencatat `H4_NEUTRAL` padahal primaryBias BUY |
| Zona S/R: pembentukan | Tersedia sebagian | `operator.ts:197 buildZones` | Swing dikelompokkan dalam 0,5×ATR14, per timeframe | Belum ada status validitas, invalidasi, atau expiry untuk zona (tidak ditemukan). Zona dibangun ulang dari awal setiap evaluasi |
| Zona: invalidasi/expiry | Belum tersedia | — | Grep `expir`/`invalidat` hanya menemukan TTL sinyal, bukan zona | Zona yang sudah ditembus tidak diberi tanda apa pun |
| Klasifikasi trend/range/reversal | Tersedia sebagian | `operator.ts:45` (konteks H1), `engine/core/market/regime/regimeClassifier.ts`, `biasEngine.derivePhase` | Definisinya tertulis di policy string | Tidak ada label BOS/CHOCH. Reversal baru terlihat sebagai MIXED setelah swing baru terkonfirmasi. Ada tiga klasifikasi yang terpisah |
| Konteks EMA dipisah dari pemicu | Tersedia sebagian | `operator.ts:19,52`; `signalEvaluator.ts:28,67–70` | ARENA: EMA5 hanya untuk timing. M1B: `emaAcceptable` adalah syarat READY | Di M1B, EMA ikut menjadi gate entry, bukan hanya konteks |
| EMA20/50/200 | Belum tersedia | — | Yang dipakai EMA 5/21/50 (`operator.ts:409`, `tradingState.ts:134`). EMA20 dan EMA200 tidak ditemukan | Kalau mau dipakai, ini komponen baru yang harus diuji dulu |
| Profil scalping/intraday/swing | Belum tersedia | `tradingStyle.ts` | `tradingStyleOf` hanya memberi label dari lama posisi dipegang, setelah trade ditutup, dan "never feeds decisions" | Tidak ada aturan timeframe, entry, atau exit per profil. Profil tidak dipilih pengguna maupun sistem |
| Horizon | Tersedia sebagian (hanya deskriptif) | `engine/core/market/horizon/*`, field journal `horizon` | Disimpan sebagai konteks | Tidak terlihat dipakai untuk memilih aturan (tidak dapat diverifikasi lebih jauh tanpa membaca ulang) |
| Kontrol risiko | Tersedia dan teruji | `engine/risk/*` (M4), `DEMO_RISK_PROFILE`, `control/contract.ts:39` (clamp), guard di bridge | Batas posisi, harian, dan kill switch | Hanya ada satu profil risiko global, bukan per gaya |
| Kondisi no-trade | Tersedia sebagian | Gate M2 (`NO_PRIMARY_BIAS`/`COUNTER_PRIMARY_BIAS`), M3 HOLD, M4 BLOCKED, TTL sinyal | Alasan blok dicatat di pipeline event | Status HOLD/WAIT dari ARENA tidak menghentikan jalur paper/demo (C3, audit sebelumnya) |
| Journal menyimpan alasan | Tersedia sebagian | `engine/journal/types.ts` (regime, horizon, contextSnapshot, primaryBias*), `engine_events` | Ada field konteks yang bisa ditambah tanpa menghapus data lama | Belum ada baris untuk posisi yang masih terbuka. Zona dan swing saat keputusan tidak disimpan |

## 3. Jawaban audit khusus

- **EMA20/50/200:** tidak ada. EMA21/50 di ARENA memberi konteks dan menentukan arah H4. Di M1B, `emaAcceptable` ikut menentukan READY. Artinya EMA berfungsi sebagai konteks sekaligus gate entry.
- **EMA5:** di ARENA dipakai untuk timing dan pullback (H1/M15/M5, `operator.ts:52,327`), tidak terikat pada profil tertentu karena profilnya memang belum ada.
- **Pemilihan profil:** tidak ada, baik secara manual maupun otomatis. Label gaya baru diberikan setelah trade ditutup.
- **Candle selesai saat keputusan:** ya. `evaluateAt(asOf)` hanya memakai data CLOSED, dan ada tes untuk batas H4.
- **Rekonstruksi SNR/struktur dari journal:** sebagian. `contextSnapshot` dan `engineSnapshot` (di intent demo) menyimpan konteks Radar. Daftar zona ARENA dan swing yang dipakai saat keputusan tidak disimpan eksplisit. Rekonstruksi penuh masih bisa dengan replay history broker, karena alurnya deterministik dengan CanonicalClock. Ini belum diverifikasi lewat tes.
- **Paper vs execution:** keduanya memakai satu jalur strategi. Demo hanya meneruskan trade paper yang sudah lolos M2/M3/M4 (`EngineHost.ts:116`, `intent.ts`). Bridge cuma menambah guard, bukan aturan strategi baru. Backtest ARENA (`backtest.ts`) memakai `evaluate()` ARENA, bukan jalur M1B/M3. Jadi backtest dan paper/demo adalah logika yang berbeda.

## 4. Target vs implementasi

| Target | Sekarang |
|---|---|
| Satu Intelligence Engine | Dua mesin (ARENA dan M1B), masing-masing menghitung EMA, ATR, swing, pola candle, dan bias sendiri |
| Profil menentukan entry/exit/risiko | Satu jalur entry tetap (M1B → M3 → M4), satu profil risiko, tanpa parameter per gaya |
| Zona punya status lengkap | Zona dibangun ulang dari awal tanpa invalidasi atau expiry |
| Keputusan bisa diaudit | Arah dan alasan blok sudah tercatat. Zona, swing, dan posisi terbuka belum |
| Backtest = jalur live | Backtest ARENA tidak sama dengan jalur paper M1B/M3 |

## 5. Prioritas bertahap (tanpa indikator baru dan tanpa menulis ulang)

1. Tetapkan ARENA sebagai satu-satunya Intelligence Engine. Bias M1B jadi diagnostik saja, dan label journal disesuaikan.
2. Satukan formula SL/TP: M3 vs `buildSidePlan`, pilih satu.
3. Putuskan apakah status HOLD/WAIT ARENA ikut menjadi gate, atau dinyatakan tegas hanya informasi.
4. Simpan snapshot zona dan swing saat keputusan, plus baris untuk posisi terbuka, di journal.
5. Samakan backtest dengan jalur paper yang sebenarnya.
6. Baru setelah itu bentuk lapisan Execution Profile di atas jalur yang sudah satu.

## 6. Keputusan strategi yang harus ditetapkan sebelum backtest bermakna

- Profil mana yang diuji pertama, dan apakah dipilih pengguna atau otomatis. Kalau otomatis, apa aturan objektifnya.
- Timeframe per profil: arah, setup, dan trigger.
- Tetap EMA21/50, atau menguji EMA20/50/200 sebagai varian terpisah.
- Peran EMA di entry: hanya konteks, atau gate.
- Definisi zona: valid, tersentuh, ditembus, dan expiry (berapa bar atau berapa kali sentuh).
- Definisi reversal: perlu BOS/CHOCH, atau cukup MIXED.
- Satu formula SL/TP dan aturan TP cap per profil.
- Risiko per profil, TTL sinyal, batas chasing (sekarang 3 bar M5 dan 1,0R, berlabel RESEARCH_REQUIRED).
- Status HOLD dari regime choppy: wajib no-trade atau tidak.
- Biaya backtest: spread dan slippage per simbol, karena sekarang backtest dihitung kotor tanpa biaya (`gross-ohlc`).

## Keterbatasan

- Ini audit kode saja. Perilaku runtime tidak diamati dan tes tidak dijalankan.
- Pemakaian horizon classifier dalam keputusan tidak dibaca tuntas.
- Isi persis `contextSnapshot` journal tidak dibaca ulang di audit ini.
