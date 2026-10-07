import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { executionControlAction } from "@/lib/control/control.functions";

type ControlInput =
  | { action: "ENABLE_DEMO" | "DISABLE_EXECUTION" | "KILL_SWITCH" }
  | { action: "UPDATE_RISK"; risk_percent: number; max_open_positions: number; max_daily_loss_percent: number; max_daily_trades: number; allowed_symbols: string[] };

// Step 2 control plane: read view for operators, actions for admins. No order button; real execution has no path.
const STALE_MS = 90_000;

export function ExecutionControlPanel() {
  const qc = useQueryClient();
  const run = useServerFn(executionControlAction);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["execution-control"], refetchInterval: 15_000,
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const [cfg, agents, audit, admin] = await Promise.all([
        supabase.from("execution_config").select("*").eq("id", 1).maybeSingle(),
        supabase.from("execution_agent_status").select("*").order("last_heartbeat", { ascending: false }),
        supabase.from("execution_audit_log").select("*").order("timestamp", { ascending: false }).limit(15),
        u.user ? supabase.rpc("has_role", { _user_id: u.user.id, _role: "admin" }) : Promise.resolve({ data: false }),
      ]);
      return { cfg: cfg.data, agents: agents.data ?? [], audit: audit.data ?? [], isAdmin: admin.data === true };
    },
  });
  const cfg = q.data?.cfg;
  const [risk, setRisk] = useState({ risk_percent: "", max_open_positions: "", max_daily_loss_percent: "", max_daily_trades: "", allowed_symbols: "" });
  useEffect(() => {
    if (cfg) setRisk({ risk_percent: String(cfg.risk_percent), max_open_positions: String(cfg.max_open_positions),
      max_daily_loss_percent: String(cfg.max_daily_loss_percent), max_daily_trades: String(cfg.max_daily_trades), allowed_symbols: cfg.allowed_symbols.join(",") });
  }, [cfg?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (payload: ControlInput) => {
    setErr(null); setBusy(true);
    try { await run({ data: payload }); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ["execution-control"] });
    await qc.invalidateQueries({ queryKey: ["demo-control"] });
  };

  if (q.isLoading) return null;
  if (!cfg) return <section className="mx-auto w-full max-w-3xl text-xs text-muted-foreground">Execution Control: hanya untuk admin/operator.</section>;
  const agent = q.data!.agents[0];
  const online = !!agent?.last_heartbeat && Date.now() - new Date(agent.last_heartbeat).getTime() < STALE_MS;
  const armed = cfg.execution_mode === "DEMO_STRESS_TEST" && cfg.demo_enabled && !cfg.kill_switch;
  const cell = "rounded border border-border p-2";

  return <section className="mx-auto w-full max-w-3xl space-y-3">
    <h2 className="text-sm font-semibold">Execution Control (cloud, demo only)</h2>
    {err && <p className="text-xs text-destructive">{err}</p>}
    <div className="grid gap-2 text-xs sm:grid-cols-3">
      <div className={cell}>Agent: <b>{agent ? (online ? `ONLINE · ${agent.agent_id}` : `OFFLINE · ${agent.agent_id}`) : "belum pernah lapor"}</b>
        {agent?.last_heartbeat && <div className="text-muted-foreground">heartbeat {new Date(agent.last_heartbeat).toISOString().slice(11, 19)} UTC · v{agent.current_version ?? "?"}</div>}</div>
      <div className={cell}>MT5: <b>{agent ? (agent.mt5_connected && online ? `CONNECTED · ${agent.account_mode ?? "?"}` : "NOT CONNECTED") : "—"}</b>
        {agent?.account_number_masked && <div className="text-muted-foreground">{agent.account_number_masked} · {agent.broker_server}</div>}</div>
      <div className={cell}>Mode: <b>{cfg.execution_mode}</b> · demo {cfg.demo_enabled ? "ON" : "OFF"}
        <div className="text-muted-foreground">{armed ? "ARMED (akun demo saja)" : "tidak ada order"}</div></div>
      <div className={cell}>Kill switch: <b className={cfg.kill_switch ? "text-destructive" : ""}>{cfg.kill_switch ? "ACTIVE" : "off"}</b></div>
      <div className={cell}>Posisi terbuka: <b>{online ? (agent?.open_positions ?? "—") : "—"}</b> / {cfg.max_open_positions}</div>
      <div className={cell}>Risk: <b>{cfg.risk_percent}%</b>/trade · loss harian {cfg.max_daily_loss_percent}% · {cfg.max_daily_trades} trade/hari
        <div className="text-muted-foreground">{cfg.allowed_symbols.join(", ")}</div></div>
    </div>
    {agent?.last_error && <p className="text-xs text-destructive">Agent error: {agent.last_error}</p>}

    {q.data!.isAdmin && <div className="space-y-2 rounded border border-border p-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || armed} onClick={() => act({ action: "ENABLE_DEMO" })}>Enable Demo Execution</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "DISABLE_EXECUTION" })}>Disable Execution</Button>
        <Button size="sm" variant="destructive" disabled={busy || cfg.kill_switch} onClick={() => act({ action: "KILL_SWITCH" })}>Activate Kill Switch</Button>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-5">
        {([["risk_percent", "Risk %"], ["max_open_positions", "Maks posisi"], ["max_daily_loss_percent", "Loss harian %"], ["max_daily_trades", "Trade/hari"], ["allowed_symbols", "Simbol"]] as const).map(([k, l]) =>
          <label key={k} className="space-y-1"><span className="text-muted-foreground">{l}</span>
            <Input className="h-8 text-xs" value={risk[k]} onChange={(e) => setRisk({ ...risk, [k]: e.target.value })} /></label>)}
      </div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "UPDATE_RISK",
        risk_percent: Number(risk.risk_percent), max_open_positions: Number(risk.max_open_positions),
        max_daily_loss_percent: Number(risk.max_daily_loss_percent), max_daily_trades: Number(risk.max_daily_trades),
        allowed_symbols: risk.allowed_symbols.split(",").map((s) => s.trim()).filter(Boolean) })}>Update Risk Limits</Button>
    </div>}

    <div className="rounded border border-border p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Audit log</h3>
      {!q.data!.audit.length ? <p className="text-xs text-muted-foreground">Belum ada perubahan.</p> :
        <ul className="space-y-1 font-mono text-[11px]">{q.data!.audit.map((a) =>
          <li key={a.id}>{new Date(a.timestamp).toISOString().slice(5, 19).replace("T", " ")} {a.event_type} {JSON.stringify(a.new_value)} · {a.source}</li>)}</ul>}
    </div>
    <p className="text-xs text-muted-foreground">Cloud hanya menyimpan konfigurasi; order dikirim oleh VPS ke akun demo yang di-whitelist. Akun real tetap MONITOR_ONLY, tidak ada jalur eksekusi real.</p>
  </section>;
}
