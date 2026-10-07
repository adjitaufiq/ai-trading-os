// Phase 4B — Market Briefing Generator (pure). Detects briefing requests and supplies a fixed section template.
// The LLM fills sections ONLY from AI_CONTEXT_PAYLOAD + MEMORY_CONTEXT; it never creates signals or levels.
export const BRIEFING_POLICY_VERSION = "briefing-v1";

const BRIEFING_RE = /\b(briefing|brief|ringkasan sesi|session brief)\b/i;

export function isBriefingRequest(text: string): boolean {
  return BRIEFING_RE.test(text);
}

export function briefingPrompt(symbol: string): string {
  return `Buat briefing ${symbol} sesi ini`;
}

export type BriefingPrice = { bid: number; ask: number; at: string | null } | null;

/** Pulls current_price from the AI_CONTEXT_PAYLOAD string (copy only, no math). */
export function extractPrice(liveContext: string): BriefingPrice {
  const m = liveContext.match(/"current_price":(\{[^}]*\}|null)/);
  if (!m || m[1] === "null") return null;
  try { const p = JSON.parse(m[1]!) as { bid?: unknown; ask?: unknown; at?: unknown };
    return typeof p.bid === "number" && typeof p.ask === "number" ? { bid: p.bid, ask: p.ask, at: typeof p.at === "string" ? p.at : null } : null;
  } catch { return null; }
}

export function priceLine(p: BriefingPrice): string {
  return p ? `**Harga (Engine Host):** Bid ${p.bid} / Ask ${p.ask} @ ${p.at ?? "waktu belum tersedia"}` : "**Harga (Engine Host):** belum tersedia";
}

export function briefingInstructions(scope: string, price: BriefingPrice = null): string {
  return `=== MODE BRIEFING (${BRIEFING_POLICY_VERSION}) ===
User meminta session briefing. Jawab PERSIS dengan struktur markdown ini (salin baris judul, Snapshot dan Harga apa adanya), isi hanya dari AI_CONTEXT_PAYLOAD dan MEMORY_CONTEXT. Field null/kosong tulis "belum tersedia". Jangan mengarang angka, jangan memberi sinyal BUY/SELL, jangan menyarankan entry.

## ${scope} SESSION BRIEF
_Snapshot: <timestamp payload> · Sumber: ENGINE HOST VPS · MONITOR_ONLY_
${priceLine(price)}

### 1. Current Market State
WAJIB baris pertama: harga sekarang dari current_price (bid / ask + waktunya), atau "belum tersedia" bila null. Lalu regime, market_phase, bias, approach, horizon, active events penting.
### 2. Engine Decision
decision + setup + confidence apa adanya, plus reasons utama engine (jangan override).
### 3. Multi-Timeframe Context
H4 / H1 / M15 / M5 dari timeframes.
### 4. Key Support / Resistance
hanya dari key_levels (sebut nama level dan angkanya).
### 5. Risk & Invalidation
risk + invalidation.
### 6. Radar Waiting Condition
confirmation_needed — apa yang harus terjadi agar keputusan engine berubah.
### 7. Memory Check
dari MEMORY_CONTEXT: berapa similar_past_states, keputusan engine saat itu, outcome paper bila ada; sebut ukuran sampel; jika < 5 tulis "sampel terlalu kecil untuk kesimpulan". Jika memory kosong/UNAVAILABLE, katakan apa adanya.

Tutup dengan satu baris: "Briefing ini deskriptif dari Engine Host, bukan sinyal trading."`;
}
