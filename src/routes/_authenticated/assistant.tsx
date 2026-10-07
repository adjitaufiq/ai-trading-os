import { createFileRoute, Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Radar, Trash2, LogOut, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { createThread, deleteThread, listThreads, threadsQueryKey } from "@/lib/assistant/threads";
import { SCOPE_LABEL, THREAD_SCOPES, TOPIC_LABEL, type ThreadScope } from "@/lib/assistant/knowledgeBase";

export const Route = createFileRoute("/_authenticated/assistant")({
  head: () => ({ meta: [
    { title: "AI Trading Assistant — Personal AI Trading OS" },
    { name: "description", content: "Asisten pengetahuan Trading OS: Radar, regime, horizon, events, dan paper trading berbasis data Engine Host live." },
    { property: "og:title", content: "AI Trading Assistant — Trading OS" },
    { property: "og:description", content: "Tanya kondisi Radar dan arti istilah engine, per simbol dan per topik." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: AssistantLayout,
});

function AssistantLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { threadId?: string };
  const { data: threads = [] } = useQuery({ queryKey: threadsQueryKey, queryFn: listThreads });
  const [busy, setBusy] = useState(false);

  const create = async (scope: ThreadScope, topic: string) => {
    setBusy(true);
    try {
      const t = await createThread(scope, topic);
      await qc.invalidateQueries({ queryKey: threadsQueryKey });
      navigate({ to: "/assistant/$threadId", params: { threadId: t.id } });
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    await deleteThread(id);
    await qc.invalidateQueries({ queryKey: threadsQueryKey });
    if (params.threadId === id) navigate({ to: "/assistant" });
  };

  return <div className="flex h-screen bg-background text-foreground">
    <aside className="flex w-72 shrink-0 flex-col border-r border-border">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Radar className="size-5 text-bull" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">AI Trading Assistant</p>
          <p className="text-[10px] text-muted-foreground">KB + Engine Host live · MONITOR_ONLY</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {(Object.keys(THREAD_SCOPES) as ThreadScope[]).map((scope) => {
          const items = threads.filter((t) => (t.symbol ?? "KNOWLEDGE") === scope);
          return <section key={scope} className="mb-3">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{SCOPE_LABEL[scope]}</span>
            </div>
            <div className="flex flex-wrap gap-1 px-2 pb-1">
              {THREAD_SCOPES[scope].map((topic) => (
                <button key={topic} disabled={busy} onClick={() => create(scope, topic)}
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">
                  <Plus className="size-3" />{TOPIC_LABEL[topic]}
                </button>
              ))}
            </div>
            {items.map((t) => (
              <div key={t.id} className={`group flex items-center rounded ${params.threadId === t.id ? "bg-accent" : "hover:bg-accent/50"}`}>
                <Link to="/assistant/$threadId" params={{ threadId: t.id }} className="min-w-0 flex-1 px-2 py-1.5">
                  <p className="truncate text-sm">{t.title}</p>
                  <p className="text-[10px] text-muted-foreground">{TOPIC_LABEL[t.topic] ?? t.topic}</p>
                </Link>
                <button aria-label="Hapus thread" onClick={() => remove(t.id)} className="p-1.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </section>;
        })}
      </nav>
      <div className="flex gap-1 border-t border-border p-2">
        <Button asChild variant="ghost" size="sm" className="flex-1"><Link to="/"><ArrowLeft className="size-4" />Terminal</Link></Button>
        <Button variant="ghost" size="sm" onClick={async () => { await supabase.auth.signOut(); navigate({ to: "/auth" }); }}><LogOut className="size-4" /></Button>
      </div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col"><Outlet /></main>
  </div>;
}
