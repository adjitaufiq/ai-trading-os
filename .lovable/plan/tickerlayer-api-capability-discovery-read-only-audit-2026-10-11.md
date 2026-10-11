# TickerLayer API Capability Discovery (Read-Only Audit)

## Temuan awal (sudah diverifikasi)

- `TICKERLAYER_API_KEY` **tidak ada** di secret store proyek (6 secret terdaftar, tidak ada TickerLayer).
- Tidak ada di environment shell sandbox.
- Tidak ada satu pun referensi "tickerlayer" di kode proyek.

Artinya: audit koneksi live **belum bisa dijalankan** sampai API key ditambahkan. Tanpa key, satu-satunya output jujur adalah "connection status: NOT CONFIGURED" — tidak boleh mengarang endpoint atau mock response.

## Rencana

### Langkah 0 — Simpan API key (butuh tindakan user)
- Minta key lewat form aman `add_secret` dengan nama `TICKERLAYER_API_KEY`.
- Key tidak pernah ditampilkan, dicetak, atau ditulis ke kode.

### Langkah 1 — Connectivity check (read-only, dari sandbox)
- Identifikasi base URL & skema auth dari dokumentasi resmi TickerLayer (web search).
- Satu request uji (endpoint paling ringan, mis. quote/status) dengan key dari env; catat HTTP status dan bentuk respons. Key hanya dibaca sebagai env var, tidak pernah di-echo.

### Langkah 2 — Capability inventory (hanya yang terverifikasi)
Untuk tiap endpoint yang didokumentasikan/ditemukan: panggil sekali dengan parameter minimal, catat:
- endpoint, method, parameter, response schema (field aktual), status (AVAILABLE / NOT AVAILABLE / ERROR).

Cakupan yang dicek:
- Market data: quote, OHLC, trade, volume
- Historical: candles, quotes
- Lainnya: news, sentiment, macro indicator, economic event

### Langkah 3 — Symbol coverage
- Gunakan endpoint daftar simbol jika ada; jika tidak, uji beberapa simbol representatif (saham, indeks, FX, crypto) dan catat mana yang benar-benar mengembalikan data. Tidak mengasumsikan simbol.

### Langkah 4 — Limitations
- Catat rate limit / request limit / batasan subscription dari header respons dan dokumentasi resmi.

### Langkah 5 — Laporan
**TickerLayer Capability Report** berisi: connection status, available endpoints, available data, unavailable data, symbol coverage, limitations, dan recommended role (mis. "Market Data Provider" atau "External Research Data Source"). Tanpa sinyal BUY/SELL.

## Batasan tegas
- Read-only: tidak ada kode proyek yang diubah, tidak ada connector permanen, tidak ada dashboard.
- TickerLayer tidak dihubungkan ke ARENA, M1B, Decision Gate, Risk Engine, atau Execution Engine.
- Tidak build, commit, deploy, publish.
- Jika key ternyata invalid atau tier tidak mendukung suatu endpoint, dicatat apa adanya (NOT AVAILABLE / tier-limited), tidak ditebak.

## Yang dibutuhkan dari user
Konfirmasi untuk meminta `TICKERLAYER_API_KEY` lewat form secret aman (Langkah 0), lalu audit berjalan read-only.
