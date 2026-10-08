import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Radar, Trash2, LogOut, ArrowLeft, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { createThread, deleteThread, listThreads, threadsQueryKey } from "@/lib/assistant/threads";
import {
  SCOPE_LABEL,
  THREAD_SCOPES,
  TOPIC_LABEL,
  type ThreadScope,
} from "@/lib/assistant/knowledgeBase";

export const Route = createFileRoute("/_authenticated/assistant")({
  head: () => ({
    meta: [
      { title: "AI Trading Assistant — Personal AI Trading OS" },
      {
        name: "description",
        content:
          "Asisten pengetahuan Trading OS: Radar, regime, horizon, events, dan paper trading berbasis data Engine Host live.",
      },
      { property: "og:title", content: "AI Trading Assistant — Trading OS" },
      {
        property: "og:description",
        content: "Tanya kondisi Radar dan arti istilah engine, per simbol dan per topik.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AssistantLayout,
});

function AssistantLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { threadId?: string };
  const { data: threads = [] } = useQuery({ queryKey: threadsQueryKey, queryFn: listThreads });
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const reportPage = pathname === "/assistant/control" || pathname === "/assistant/research";
  const pageTitle =
    pathname === "/assistant/control"
      ? "Kontrol"
      : pathname === "/assistant/research"
        ? "Riset"
        : "AI Trading Assistant";

  const create = async (scope: ThreadScope, topic: string) => {
    setBusy(true);
    try {
      const t = await createThread(scope, topic);
      await qc.invalidateQueries({ queryKey: threadsQueryKey });
      setMenuOpen(false);
      navigate({ to: "/assistant/$threadId", params: { threadId: t.id } });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await deleteThread(id);
    await qc.invalidateQueries({ queryKey: threadsQueryKey });
    if (params.threadId === id) navigate({ to: "/assistant" });
  };

  const navigation = (
    <>
      <nav aria-label="Daftar percakapan" className="min-h-0 flex-1 overflow-y-auto p-3">
        {(Object.keys(THREAD_SCOPES) as ThreadScope[]).map((scope) => {
          const items = threads.filter((t) => (t.symbol ?? "KNOWLEDGE") === scope);
          return (
            <section key={scope} className="mb-3">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {SCOPE_LABEL[scope]}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 px-2 pb-1">
                {THREAD_SCOPES[scope].map((topic) => (
                  <Button
                    variant="outline"
                    size="sm"
                    key={topic}
                    disabled={busy}
                    onClick={() => create(scope, topic)}
                    className="h-auto min-h-9 whitespace-normal px-2 py-1 text-xs text-muted-foreground"
                  >
                    <Plus className="size-3" />
                    {TOPIC_LABEL[topic]}
                  </Button>
                ))}
              </div>
              {items.map((t) => (
                <div
                  key={t.id}
                  className={`group flex items-center rounded ${params.threadId === t.id ? "bg-accent" : "hover:bg-accent/50"}`}
                >
                  <Link
                    to="/assistant/$threadId"
                    params={{ threadId: t.id }}
                    onClick={() => setMenuOpen(false)}
                    className="min-w-0 flex-1 px-2 py-2.5"
                  >
                    <p className="truncate text-sm">{t.title}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {TOPIC_LABEL[t.topic] ?? t.topic}
                    </p>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Hapus percakapan ${t.title}`}
                    onClick={() => remove(t.id)}
                    className="shrink-0 text-muted-foreground md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </section>
          );
        })}
      </nav>
      <div className="flex gap-1 border-t border-border p-2">
        <Button asChild variant="ghost" size="sm" className="flex-1">
          <Link to="/">
            <ArrowLeft className="size-4" />
            Terminal
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Keluar akun"
          title="Keluar akun"
          onClick={async () => {
            await supabase.auth.signOut();
            navigate({ to: "/auth" });
          }}
        >
          <LogOut className="size-4" />
        </Button>
      </div>
    </>
  );

  return (
    <div className="assistant-cockpit flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-3 py-3 md:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {!reportPage && (
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 md:hidden"
                  aria-label="Buka percakapan"
                  title="Percakapan"
                >
                  <PanelLeft />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="flex w-[min(90vw,22rem)] max-w-none flex-col gap-0 p-0"
              >
                <div className="border-b border-border p-4 pr-12">
                  <SheetTitle>Percakapan</SheetTitle>
                  <SheetDescription>AI Trading Assistant</SheetDescription>
                </div>
                {navigation}
              </SheetContent>
            </Sheet>
          )}
          <Radar className="hidden size-6 shrink-0 text-bull sm:block" aria-hidden />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold sm:text-base">{pageTitle}</h1>
            <p className="text-[10px] text-muted-foreground sm:text-xs">
              Engine Host · AI MONITOR_ONLY
            </p>
          </div>
        </div>
        {reportPage && (
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              <ArrowLeft className="size-4" />
              Terminal
            </Link>
          </Button>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        {!reportPage && (
          <aside className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
            {navigation}
          </aside>
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
