import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { generateTradeReview } from "@/lib/review/review.functions";
import { Button } from "@/components/ui/button";

interface Review { trade_id: string; compliance_status: string; compliance: { id: string; status: string; detail: string }[]; narrative: string; created_at: string }

// Phase 5A: lists closed paper trades and their immutable AI reviews. View + "generate once" only.
export function TradeReviewPanel() {
  const qc = useQueryClient();
  const gen = useServerFn(generateTradeReview);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["trade-reviews"],
    queryFn: async () => {
      const [t, r] = await Promise.all([
        supabase.rpc("log_engine_access", { _scope: "trade_review_panel" }),
        supabase.from("engine_trades").select("trade_id,symbol,direction,result,r_multiple,closed_at").order("closed_at", { ascending: false }).limit(50),
        supabase.from("trade_reviews").select("trade_id,compliance_status,compliance,narrative,created_at").limit(500),
      ]);
      return { trades: t.data ?? [], reviews: new Map(((r.data ?? []) as unknown as Review[]).map((x) => [x.trade_id, x])) };
    },
  });
  const run = async (tradeId: string) => {
    setBusy(tradeId); setErr(null);
    try { await gen({ data: { tradeId } }); await qc.invalidateQueries({ queryKey: ["trade-reviews"] }); }
    catch (e) { setErr(e instanceof Error ? e.message : "Gagal membuat review"); }
    finally { setBusy(null); }
  };
  return <section className="mx-auto w-full max-w-3xl space-y-3">
    <h2 className="text-sm font-semibold">Trade Review (paper trade tertutup, deskriptif)</h2>
    {err && <p className="text-xs text-destructive">{err}</p>}
    {!data?.trades.length ? <p className="text-xs text-muted-foreground">Belum ada paper trade tertutup untuk direview.</p> :
      data.trades.map((t) => {
        const rv = data.reviews.get(t.trade_id);
        return <div key={t.trade_id} className="rounded border border-border p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono">{t.symbol} · {t.direction} · {t.result} · R {t.r_multiple ?? "—"} · {new Date(t.closed_at).toISOString().slice(0, 16)}Z</span>
            {rv ? <span className="font-semibold">{rv.compliance_status}</span> :
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(t.trade_id)}>{busy === t.trade_id ? "Mereview…" : "Buat review"}</Button>}
          </div>
          {rv && <div className="mt-2 space-y-2">
            <ul className="space-y-0.5">{rv.compliance.map((c) => <li key={c.id}><span className="font-mono">{c.status}</span> {c.id} — {c.detail}</li>)}</ul>
            <p className="whitespace-pre-wrap text-muted-foreground">{rv.narrative}</p>
          </div>}
        </div>;
      })}
  </section>;
}
