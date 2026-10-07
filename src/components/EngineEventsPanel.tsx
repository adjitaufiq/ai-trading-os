import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Proof of life: projection of append-only engine_events (READY → OPEN / BLOCK per signal). Monitoring only:
// execution is automatic on the VPS (demo account only); there is no order button here and AI never executes.
type Ev = {
  id: string; symbol: string; event_type: string; stage: string | null; signal_id: string | null; occurred_at: string;
  direction: string | null; confidence: number | null; reason: string; entry: number | null; stop_loss: number | null; take_profit: number | null;
};
type Note = { event_id: string; delivery_status: string; note: string | null; attempted_at: string };

const fmt = (iso: string) => new Date(iso).toLocaleString("id-ID", { hour12: false, timeZone: "UTC" }) + " UTC";

export function EngineEventsPanel() {
  const q = useQuery({
    queryKey: ["engine-events"], refetchInterval: 30_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 72 * 3600_000).toISOString();
      const [e, n, h] = await Promise.all([
        supabase.from("engine_events").select("id,symbol,event_type,stage,signal_id,occurred_at,direction,confidence,reason,entry,stop_loss,take_profit").gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(1000),
        supabase.from("engine_notifications").select("event_id,delivery_status,note,attempted_at").order("attempted_at", { ascending: false }).limit(500),
        supabase.from("execution_agent_status").select("agent_id,last_heartbeat,mt5_connected").order("last_heartbeat", { ascending: false }).limit(1),
      ]);
      void supabase.rpc("log_engine_access", { _scope: "engine_events_panel" });
      return { hb: (h.data?.[0] ?? null) as { agent_id: string; last_heartbeat: string | null; mt5_connected: boolean } | null, events: (e.data ?? []) as Ev[], notes: (n.data ?? []) as Note[], error: e.error?.message ?? null };
    },
  });
  const events = q.data?.events ?? [];
  const noteOf = new Map<string, Note>();
  for (const n of q.data?.notes ?? []) if (!noteOf.has(n.event_id)) noteOf.set(n.event_id, n);
  const symbols = ["XAUUSD", "BTCUSD"];
  const tradeEv = events.filter((e) => e.symbol !== "ALL");
  const lastExec = tradeEv.find((e) => e.event_type === "EXECUTION" || e.event_type === "EXIT");
  const lastEv = tradeEv[0];
  const health = events.find((e) => e.event_type === "ENGINE_OFFLINE" || e.event_type === "ENGINE_ONLINE");
  const hb = q.data?.hb ?? null;
  const hbAge = hb?.last_heartbeat ? (Date.now() - new Date(hb.last_heartbeat).getTime()) / 1000 : null;
  const hbLabel = hbAge === null ? "BELUM ADA HEARTBEAT" : hbAge < 60 ? `ONLINE · ${Math.round(hbAge)} dtk lalu` : `STALE · ${Math.round(hbAge / 60)} mnt lalu`;

  return <section className="mx-auto w-full max-w-3xl space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">Engine Proof of Life (72 jam)</h2>
      <span className="text-xs text-muted-foreground">Eksekusi otomatis di VPS · akun demo saja · tanpa tombol order</span>
    </div>
    <div className="grid grid-cols-2 gap-2 rounded border border-border p-3 text-xs sm:grid-cols-4">
      <div><div className="text-muted-foreground">READY</div><b>{tradeEv.filter((e) => e.event_type === "READY").length}</b></div>
      <div><div className="text-muted-foreground">OPEN</div><b>{tradeEv.filter((e) => e.event_type === "EXECUTION" && !/REJECT|ERROR/i.test(e.reason)).length}</b></div>
      <div><div className="text-muted-foreground">BLOCK</div><b>{tradeEv.filter((e) => e.event_type === "BLOCKED").length}</b></div>
      <div><div className="text-muted-foreground">Heartbeat agent VPS</div><b className={hbAge !== null && hbAge < 60 ? "" : "text-destructive"}>{hbLabel}</b></div>
      <div className="col-span-2"><div className="text-muted-foreground">Eksekusi terakhir</div>{lastExec ? `${lastExec.symbol} ${lastExec.event_type} ${lastExec.direction ?? ""} · ${fmt(lastExec.occurred_at)}` : "Belum ada"}</div>
      <div><div className="text-muted-foreground">Event terakhir</div>{lastEv ? fmt(lastEv.occurred_at) : "—"}</div>
      <div><div className="text-muted-foreground">Engine host</div><b className={health?.event_type === "ENGINE_OFFLINE" ? "text-destructive" : ""}>{health?.event_type === "ENGINE_OFFLINE" ? "OFFLINE" : "ONLINE"}</b></div>
    </div>
    {q.data?.error && <p className="text-xs text-destructive">{q.data.error}</p>}
    <div className="grid gap-2 sm:grid-cols-2">
      {symbols.map((sym) => {
        const se = events.filter((e) => e.symbol === sym);
        const ready = se.filter((e) => e.event_type === "READY");
        const bySig = (id: string | null, t: string) => se.filter((e) => e.signal_id === id && e.event_type === t);
        const opened = ready.filter((r) => bySig(r.signal_id, "EXECUTION").length > 0).length;
        const blocked = se.filter((e) => e.event_type === "BLOCKED");
        const reasons = new Map<string, number>();
        for (const b of blocked) { const k = `${b.stage}: ${b.reason.split(" ").slice(0, 2).join(" ")}`; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
        const cur = ready[0];
        const curExec = cur ? se.filter((e) => e.signal_id === cur.signal_id && e.event_type !== "READY") : [];
        const plan = curExec.find((e) => e.stop_loss !== null) ?? null;
        return <div key={sym} className="space-y-2 rounded border border-border p-3 text-xs">
          <div className="flex justify-between"><b>{sym}</b><span className="text-muted-foreground">RADAR {se.filter((e) => e.event_type === "RADAR").length}</span></div>
          <div>READY <b>{ready.length}</b> → OPEN <b>{opened}</b> · BLOCK <b>{blocked.length}</b></div>
          {reasons.size > 0 && <ul className="text-muted-foreground">{[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => <li key={k}>{k} × {v}</li>)}</ul>}
          <div className="rounded bg-muted p-2">
            <div className="mb-1 font-semibold">READY terakhir</div>
            {!cur ? <span className="text-muted-foreground">Belum ada READY.</span> : <>
              <div>{cur.direction} · {fmt(cur.occurred_at)} · confidence {cur.confidence ?? "—"}</div>
              <div>Entry {plan?.entry ?? "—"} · SL {plan?.stop_loss ?? "—"} · TP {plan?.take_profit ?? "—"}</div>
              <div className="text-muted-foreground">{cur.reason}</div>
              <div>Hasil: {curExec.length ? curExec.map((e) => `${e.event_type}/${e.stage} ${e.reason}`).join(" · ") : "menunggu"}</div>
            </>}
          </div>
        </div>;
      })}
    </div>
    <div className="rounded border border-border p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Event terbaru</h3>
      {!events.length ? <p className="text-xs text-muted-foreground">Belum ada event tercatat.</p> :
        <table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th>Waktu</th><th>Simbol</th><th>Event</th><th>Arah</th><th>Alasan</th><th>Alert</th></tr></thead>
          <tbody>{events.filter((e) => e.event_type !== "RADAR").slice(0, 40).map((e) => { const n = noteOf.get(e.id); return <tr key={e.id} className="border-t border-border">
            <td>{fmt(e.occurred_at)}</td><td>{e.symbol}</td><td>{e.event_type}/{e.stage}</td><td>{e.direction ?? "—"}</td><td>{e.reason}</td>
            <td title={n?.note ?? ""}>{n?.delivery_status ?? "—"}</td></tr>; })}</tbody></table>}
    </div>
  </section>;
}
