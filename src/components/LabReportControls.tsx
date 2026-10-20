import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { generateLabReport } from "@/lib/report/labReport.functions";

type Report = { filename: string; blob: Blob; at: string; trades?: number; net?: number };

function download(r: Report) {
  const url = URL.createObjectURL(r.blob);
  const a = document.createElement("a");
  a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Read-only report export: rebuilds the workbook on the server from stored history. */
export function LabReportControls() {
  const gen = useServerFn(generateLabReport);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const last = useRef<Report | null>(null);
  const [, force] = useState(0);
  const update = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await gen();
      if (!r.ok || !r.base64) { setMsg(`Gagal: ${r.note ?? r.status}`); return; }
      const bin = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      last.current = { filename: r.filename!, blob: new Blob([bin as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), at: new Date().toLocaleString("id-ID"), trades: r.trades, net: r.net };
      setMsg(`Laporan diperbarui ${last.current.at} · ${r.trades} trade unik · net ${r.net}`);
      force((n) => n + 1);
    } catch (e) { setMsg(`Gagal: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="lab-report-controls">
    <Button size="sm" variant="outline" onClick={update} disabled={busy}>{busy ? "Memproses…" : "UPDATE DATA & REPORT"}</Button>
    <Button size="sm" variant="outline" disabled={!last.current} onClick={() => last.current && download(last.current)}>DOWNLOAD EXCEL</Button>
    {msg ? <span role="status" className="text-muted-foreground">{msg}</span> : null}
  </div>;
}
