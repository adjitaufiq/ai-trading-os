// Trading OS Knowledge Base (global, versioned, code-owned). The AI Trading Assistant answers definitions ONLY from
// these entries; live facts come only from the Engine Host snapshot. AI ≠ authority: no entry grants a decision.
export const KNOWLEDGE_BASE_VERSION = "trading-os-kb-v1" as const;

export interface KbEntry {
  readonly id: string;
  readonly category: "MARKET_REGIME" | "HORIZON" | "MARKET_APPROACH" | "ACTIVE_EVENTS" | "ENGINE_HOST" | "PAPER_TRADING" | "RADAR_FAQ" | "TRADING_RULES";
  /** Engine enum(s) this entry maps to; empty when the term is UI/operator vocabulary only. */
  readonly engineTerms: readonly string[];
  readonly definition: string;
  readonly behavior?: string;
  readonly implication?: string;
  readonly radar?: string;
}

export const KNOWLEDGE_BASE: readonly KbEntry[] = [
  // 1. MARKET REGIME (engine M1B.9: TREND_CONTINUATION | RANGE_COMPRESSION | VOLATILITY_EXPANSION | TRANSITION | TREND_EXHAUSTION)
  { id: "TRENDING", category: "MARKET_REGIME", engineTerms: ["TREND_CONTINUATION", "TREND_EXHAUSTION"],
    definition: "Pasar bergerak searah: struktur H4 dan H1 selaras (HH/HL untuk bullish, LH/LL untuk bearish). Di engine disebut TREND_CONTINUATION; jika momentum H4 melemah/ATR mengecil disebut TREND_EXHAUSTION.",
    behavior: "Pullback dangkal lalu lanjut searah tren; swing baru terus terbentuk.",
    implication: "Cari pullback searah bias H4; hindari melawan tren. Exhaustion = waspada, target diperkecil.",
    radar: "Horizon INTRADAY/TREND_FOLLOW (SWING bila daily/weekly selaras). Radar tetap menunggu trigger M15/M5 closed." },
  { id: "RANGE", category: "MARKET_REGIME", engineTerms: ["RANGE_COMPRESSION"],
    definition: "Harga bolak-balik di antara support dan resistance tanpa arah dominan. Engine tidak punya enum RANGE terpisah; range dengan volatilitas rendah diklasifikasikan RANGE_COMPRESSION, phase MTF bisa RANGE.",
    behavior: "Pantulan di batas atas/bawah, breakout palsu sering terjadi.",
    implication: "Beli dekat support / jual dekat resistance hanya jika batas jelas; jangan kejar di tengah range.",
    radar: "Mean reversion bila batas M15 cukup lebar, selain itu NO_FIT." },
  { id: "RANGE_COMPRESSION", category: "MARKET_REGIME", engineTerms: ["RANGE_COMPRESSION"],
    definition: "Range yang menyempit: percentile ATR M15 rendah (≤25%) dan swing H4 saling tumpang tindih. Energi terkumpul sebelum ekspansi.",
    behavior: "Candle kecil, volatilitas turun, harga terjepit di zona sempit.",
    implication: "Scalping mean-reversion hanya jika batas M15 lebar ≥ 1×ATR; bersiap untuk breakout, tapi jangan menebak arahnya.",
    radar: "Horizon SCALPING/MEAN_REVERSION bila batas jelas; dead market (ATR sangat rendah + range sempit) ⇒ NO_FIT." },
  { id: "TRANSITION", category: "MARKET_REGIME", engineTerms: ["TRANSITION"],
    definition: "Struktur sedang berubah: H4 vs H1 konflik, MSS terdeteksi tapi belum terkonfirmasi, atau swing H4 overlap saat tren. Phase MTF TRANSITION = swing H4 diuji/ditembus tanpa kelanjutan.",
    behavior: "Arah tidak jelas, whipsaw, sinyal sering gagal.",
    implication: "Paling berisiko; tunggu struktur baru terkonfirmasi.",
    radar: "Horizon NO_FIT (REGIME_UNSTABLE_VETO). Radar mengobservasi saja." },
  { id: "VOLATILE", category: "MARKET_REGIME", engineTerms: ["VOLATILITY_EXPANSION"],
    definition: "Volatilitas melonjak: percentile ATR M15 ≥ 85%. Engine menyebutnya VOLATILITY_EXPANSION (prioritas klasifikasi tertinggi).",
    behavior: "Candle besar, spread melebar, slippage tinggi, sering terkait berita.",
    implication: "Risiko per trade membesar; SL harus lebih lebar atau tidak trading.",
    radar: "Horizon NO_FIT (REGIME_UNSTABLE_VETO); event VOLATILITY_EXPANSION dicatat." },

  // 2. HORIZON (engine M1B.10)
  { id: "SCALPING", category: "HORIZON", engineTerms: ["SCALPING"], definition: "Holding menit (M5/M15). Cocok saat range terkompresi dengan batas M15 jelas, atau tren bersih dengan momentum M5 searah H4.", implication: "Target kecil, butuh spread rendah dan disiplin tinggi." },
  { id: "INTRADAY", category: "HORIZON", engineTerms: ["INTRADAY"], definition: "Holding dalam satu sesi (jam). Muncul saat regime TREND_CONTINUATION.", implication: "Ikuti tren H4 dengan entry dari pullback H1/M15." },
  { id: "SWING", category: "HORIZON", engineTerms: ["SWING"], definition: "Holding hari. Hanya bila daily dan weekly searah dengan H4 (POSITION_HORIZON).", implication: "SL lebih lebar, ukuran posisi lebih kecil." },
  { id: "NO_FIT", category: "HORIZON", engineTerms: ["NO_FIT"], definition: "Tidak ada gaya trading yang cocok: regime tidak stabil (TRANSITION/VOLATILITY_EXPANSION/TREND_EXHAUSTION), pasar mati, atau tidak ada aturan yang cocok.", implication: "Observasi saja. Ini bukan error, tapi proteksi." },

  // 3. MARKET APPROACH (engine: MOMENTUM | MEAN_REVERSION | TREND_FOLLOW | NO_CLEAR_EDGE)
  { id: "TREND_FOLLOWING", category: "MARKET_APPROACH", engineTerms: ["TREND_FOLLOW"], definition: "Masuk searah tren H4 setelah pullback. Enum engine: TREND_FOLLOW.", implication: "Entry di pullback, SL di balik swing terkonfirmasi." },
  { id: "BREAKOUT", category: "MARKET_APPROACH", engineTerms: ["BREAKOUT_BUY", "BREAKOUT_SELL"], definition: "Masuk saat harga menembus level kunci dengan close konfirmasi. Bukan enum approach di horizon classifier; muncul sebagai setup MTF BREAKOUT_BUY/BREAKOUT_SELL.", implication: "Butuh close candle di luar level; breakout tanpa close = belum valid." },
  { id: "MEAN_REVERSION", category: "MARKET_APPROACH", engineTerms: ["MEAN_REVERSION"], definition: "Main pantulan di batas range kembali ke tengah. Muncul bersama RANGE_COMPRESSION + SCALPING.", implication: "Target ke tengah/sisi lain range; invalid bila range jebol." },
  { id: "MOMENTUM", category: "MARKET_APPROACH", engineTerms: ["MOMENTUM"], definition: "Ikut dorongan kuat jangka pendek: M15 searah H4 tanpa MSS dan momentum M5 (EMA5/21) searah.", implication: "Entry cepat, manajemen ketat." },
  { id: "WAIT", category: "MARKET_APPROACH", engineTerms: ["NO_CLEAR_EDGE"], definition: "Tidak ada keunggulan statistik yang jelas. Enum engine: NO_CLEAR_EDGE.", implication: "Tidak ada setup; tunggu." },

  // 4. ACTIVE EVENTS (footprint tags M1B.8 + event store M1B.11)
  { id: "FVG_ACTIVE", category: "ACTIVE_EVENTS", engineTerms: ["FVG_ACTIVE"], definition: "Fair Value Gap: celah harga 3-candle (high candle-1 < low candle-3 atau sebaliknya) yang belum terisi.", implication: "Zona potensi reaksi/magnet harga. Hanya tag konteks, bukan sinyal." },
  { id: "FVG_MITIGATED", category: "ACTIVE_EVENTS", engineTerms: ["FVG_MITIGATED"], definition: "FVG yang sudah disentuh/diisi kembali oleh harga.", implication: "Zona tersebut sudah 'terpakai'; reaksi berikutnya cenderung lebih lemah." },
  { id: "LIQUIDITY_SWEEP", category: "ACTIVE_EVENTS", engineTerms: ["LIQUIDITY_SWEEP"], definition: "Harga menembus swing high/low sebelumnya (mengambil stop) lalu close kembali ke dalam.", implication: "Bisa jadi awal reversal, tapi tetap perlu konfirmasi struktur." },
  { id: "BREAK_STRUCTURE", category: "ACTIVE_EVENTS", engineTerms: ["STRUCTURE_SHIFT"], definition: "Perubahan struktur pasar (BOS/MSS) terkonfirmasi. Di engine event-nya bernama STRUCTURE_SHIFT.", implication: "Bias bisa berubah; trade lama searah lama perlu ditinjau." },
  { id: "HORIZON_CHANGE", category: "ACTIVE_EVENTS", engineTerms: ["HORIZON_CHANGE"], definition: "Horizon yang direkomendasikan berubah (mis. INTRADAY → NO_FIT).", implication: "Gaya trading yang cocok berubah; sesuaikan ekspektasi." },

  // 5. ENGINE HOST
  { id: "SOURCE_ENGINE_HOST_VPS", category: "ENGINE_HOST", engineTerms: ["ENGINE_HOST"], definition: "Semua data dashboard dihitung oleh Engine Host di VPS (24/7), browser hanya viewer. Refresh/tutup browser tidak mereset engine." },
  { id: "ONLINE", category: "ENGINE_HOST", engineTerms: ["ONLINE"], definition: "Runtime simbol hidup, baseline histori siap, dan menerima tick live. State lain: STARTING, BOOTSTRAP (baseline belum siap), SYNCING, DEGRADED, OFFLINE." },
  { id: "ACTIVE", category: "ENGINE_HOST", engineTerms: ["ACTIVE"], definition: "Status radar: evaluasi M5 CLOSED terakhir < 10 menit. Lainnya: INITIALIZING (belum ada evaluasi), STALE (>10 menit tanpa evaluasi), ERROR." },
  { id: "MOUNTED", category: "ENGINE_HOST", engineTerms: ["MOUNTED"], definition: "MarketRuntime simbol sudah terpasang ke gateway MT5 (spec, offset waktu, WebSocket, bootstrap histori)." },
  { id: "REAL_MT5", category: "ENGINE_HOST", engineTerms: ["REAL_MT5"], definition: "Data berasal dari broker MT5 nyata (Exness Demo) dengan spesifikasi BROKER_REPORTED. Kebalikannya SYNTHETIC (data uji)." },
  { id: "OBSERVATION_ONLY", category: "ENGINE_HOST", engineTerms: ["MONITOR_ONLY"], definition: "Mode operasi MONITOR_ONLY, execution_enabled=false. Sistem TIDAK bisa mengirim order nyata — kemampuan itu memang tidak ada. Semua trade adalah simulasi paper." },

  // 6. PAPER TRADING
  { id: "VIRTUAL_TRADE", category: "PAPER_TRADING", engineTerms: ["PAPER"], definition: "Trade simulasi di akun virtual ($10.000, risiko 1%/trade). Fill dari bid/ask live terakhir, exit dievaluasi pada candle CLOSED berikutnya. Tidak ada uang nyata." },
  { id: "JOURNAL", category: "PAPER_TRADING", engineTerms: ["JOURNAL"], definition: "Catatan append-only tiap trade paper (entry, SL, TP, hasil, sumber data). Immutable: hasil tidak menulis ulang histori." },
  { id: "ENTRY", category: "PAPER_TRADING", engineTerms: [], definition: "Harga masuk posisi. Dibekukan saat sinyal READY lahir; tidak bergerak diam-diam." },
  { id: "STOP_LOSS", category: "PAPER_TRADING", engineTerms: [], definition: "Level keluar rugi. Di scalp plan diambil dari swing M15→M5 terkonfirmasi; level dibekukan saat posisi dibuka." },
  { id: "RISK_REWARD", category: "PAPER_TRADING", engineTerms: ["BAD_RR"], definition: "Rasio potensi profit vs risiko (jarak TP ÷ jarak SL). TP2 dibatasi zona lawan terdekat; di bawah 1.0R ⇒ BAD_RR, entry ditahan." },
  { id: "CLOSE_TRADE", category: "PAPER_TRADING", engineTerms: [], definition: "Posisi ditutup saat candle CLOSED menyentuh SL atau TP. SL dan TP di candle sama ⇒ AMBIGUOUS (dicatat jujur)." },
  { id: "PROFIT_LOSS", category: "PAPER_TRADING", engineTerms: [], definition: "Hasil trade dalam USD dan R. Realized = sudah ditutup; unrealized = posisi terbuka ditandai ke harga live." },

  // 7. RADAR FAQ / RULES
  { id: "NO_SETUP", category: "RADAR_FAQ", engineTerms: ["HOLD", "NO_SETUP", "WAIT_CONFIRMATION"], definition: "Syarat belum terpenuhi: konflik H4/H1, momentum M15/M5 tidak searah, lokasi harga belum valid, atau trigger closed-candle belum muncul. Entry/SL/TP sengaja tidak ditampilkan agar tidak ada sinyal palsu." },
  { id: "CONFIDENCE", category: "TRADING_RULES", engineTerms: ["confidence"], definition: "Skor deskriptif MTF (H4 35, H1 30, M15 20, M5 10, Quality 5). Confidence tinggi ≠ entry. READY butuh ≥75 + struktur, setup, dan konfirmasi terpenuhi." },
  { id: "CLOSED_CANDLE", category: "TRADING_RULES", engineTerms: ["CLOSED"], definition: "Semua evaluasi hanya memakai candle yang sudah close. Candle forming tidak pernah mengubah keputusan." },
  { id: "AI_NOT_AUTHORITY", category: "TRADING_RULES", engineTerms: [], definition: "Assistant hanya menjelaskan. Engine adalah sumber fakta; AI tidak menghitung ulang, tidak mengirim order, tidak mengubah risiko." },
];

/** Compact text form injected into the model instructions. */
export function knowledgeBaseText(): string {
  return KNOWLEDGE_BASE.map((e) => {
    const parts = [`[${e.category}] ${e.id}${e.engineTerms.length ? ` (engine: ${e.engineTerms.join("/")})` : ""}: ${e.definition}`];
    if (e.behavior) parts.push(`  Perilaku: ${e.behavior}`);
    if (e.implication) parts.push(`  Implikasi: ${e.implication}`);
    if (e.radar) parts.push(`  Radar: ${e.radar}`);
    return parts.join("\n");
  }).join("\n");
}

export const THREAD_SCOPES = {
  XAUUSD: ["RADAR", "SETUP", "JOURNAL"],
  BTCUSD: ["RADAR", "SETUP", "JOURNAL"],
  ENGINE: ["HEALTH", "GATEWAY", "DATA_SOURCE"],
  KNOWLEDGE: ["REGIME", "HORIZON", "APPROACH", "EVENTS", "RULES"],
} as const;
export type ThreadScope = keyof typeof THREAD_SCOPES;
export const SCOPE_LABEL: Record<ThreadScope, string> = { XAUUSD: "XAUUSD", BTCUSD: "BTCUSD", ENGINE: "Engine Host", KNOWLEDGE: "Knowledge Base" };
export const TOPIC_LABEL: Record<string, string> = {
  RADAR: "Penjelasan Radar", SETUP: "Review Setup", JOURNAL: "Review Jurnal", HEALTH: "Health", GATEWAY: "Gateway", DATA_SOURCE: "Sumber Data",
  REGIME: "Regime", HORIZON: "Horizon", APPROACH: "Market Approach", EVENTS: "Active Events", RULES: "Aturan Trading",
};
