import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { briefingPrompt } from "@/lib/assistant/briefing";
import { supabase } from "@/integrations/supabase/client";
import { loadThread, threadsQueryKey, type AssistantThread } from "@/lib/assistant/threads";
import { SCOPE_LABEL, TOPIC_LABEL, type ThreadScope } from "@/lib/assistant/knowledgeBase";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, type PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";

export const Route = createFileRoute("/_authenticated/assistant/$threadId")({
  component: ThreadPage,
  head: () => ({ meta: [
    { title: "Percakapan Analis — Personal AI Trading OS" },
    { name: "description", content: "Percakapan analis per simbol berdasarkan fakta Engine Host dan memori historis." },
    { property: "og:title", content: "Percakapan Analis — Personal AI Trading OS" },
    { property: "og:description", content: "Penjelasan keputusan engine dan kondisi radar; AI tidak membuat sinyal atau mengeksekusi order." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
});

const SUGGESTIONS: Record<string, string[]> = {
  XAUUSD: ["Buat briefing XAUUSD sesi ini", "Apa yang terjadi sekarang?", "Kenapa NO SETUP?", "Jelaskan active events saat ini"],
  BTCUSD: ["Buat briefing BTCUSD sesi ini", "Apa yang terjadi sekarang?", "Kenapa NO SETUP?", "Horizon apa yang cocok sekarang?"],
  ENGINE: ["Apakah engine host sehat?", "Apa arti MOUNTED dan ACTIVE?", "Is OBSERVATION_ONLY real trading?"],
  KNOWLEDGE: ["Apa arti RANGE_COMPRESSION?", "Bedanya FVG_ACTIVE dan FVG_MITIGATED?", "What does NO_FIT mean?"],
};

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["assistant-thread", threadId], queryFn: () => loadThread(threadId), staleTime: Infinity });
  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Memuat thread…</div>;
  if (error) return <div className="p-6 text-sm text-warn">Gagal memuat thread: {(error as Error).message}</div>;
  if (!data?.thread) return <div className="p-6 text-sm">Thread tidak ditemukan. <Link to="/assistant" className="underline">Kembali</Link></div>;
  return <ChatWindow key={threadId} thread={data.thread} initial={data.messages} />;
}

function ChatWindow({ thread, initial }: { thread: AssistantThread; initial: UIMessage[] }) {
  const qc = useQueryClient();
  const scope = (thread.symbol ?? "KNOWLEDGE") as ThreadScope;
  const [err, setErr] = useState<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({
    api: "/api/assistant-chat",
    body: { threadId: thread.id },
    headers: async (): Promise<Record<string, string>> => {
      const { data } = await supabase.auth.getSession();
      const t = data.session?.access_token;
      return t ? { Authorization: `Bearer ${t}` } : {};
    },
  }), [thread.id]);
  const { messages, sendMessage, status, stop } = useChat({
    id: thread.id, messages: initial, transport,
    onError: (e) => {
      let m = e.message;
      try { const j = JSON.parse(m) as { error?: string }; if (j.error) m = j.error; } catch { /* plain text */ }
      setErr(m);
    },
    onFinish: () => {
      qc.invalidateQueries({ queryKey: threadsQueryKey });
      qc.setQueryData(["assistant-thread", thread.id], undefined);
    },
  });
  const busy = status === "submitted" || status === "streaming";
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!busy) taRef.current?.focus(); }, [busy]);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    setErr(null);
    void sendMessage({ text });
  };
  const onSubmit = (m: PromptInputMessage) => send(m.text);

  return <>
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
      <div className="min-w-0 space-y-1"><div className="flex min-w-0 items-center gap-2">
      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground">{SCOPE_LABEL[scope]}</span>
      <span className="truncate text-xs text-muted-foreground">{TOPIC_LABEL[thread.topic] ?? thread.topic}</span>
      </div><p className="truncate text-xs font-medium">{thread.title}</p></div>
      {scope === "XAUUSD" || scope === "BTCUSD" ? (
        <Button variant="outline" size="sm" onClick={() => send(briefingPrompt(scope))} disabled={busy} className="shrink-0">
          <FileText className="size-3" /> Briefing
        </Button>
      ) : null}
    </header>
    <Conversation className="min-h-0 min-w-0 flex-1">
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 sm:px-6">
        {messages.length === 0 ? (
          <ConversationEmptyState icon={<Radar className="size-8 text-bull" />} title={`Thread ${SCOPE_LABEL[scope]}`}
            description="Tanya arti istilah engine atau kondisi Radar saat ini.">
            <div className="flex w-full flex-col items-center gap-4"><Radar className="size-9 text-bull" /><h2 className="text-base font-semibold">{SCOPE_LABEL[scope]} · Analis pasar</h2><div className="grid w-full gap-2 sm:grid-cols-2">
              {(SUGGESTIONS[scope] ?? []).map((s) => (
                <Button variant="outline" key={s} disabled={busy} onClick={() => send(s)} className="h-auto min-h-11 whitespace-normal px-3 py-2 text-xs">{s}</Button>
              ))}
            </div></div>
          </ConversationEmptyState>
        ) : messages.map((m) => (
          <Message key={m.id} from={m.role} className="min-w-0 max-w-full">
            <MessageContent className="break-words [overflow-wrap:anywhere] group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground">
              {m.parts.map((p, i) => p.type === "text"
                ? (m.role === "assistant" ? <MessageResponse key={i}>{p.text}</MessageResponse> : <span key={i} className="whitespace-pre-wrap">{p.text}</span>)
                : null)}
            </MessageContent>
          </Message>
        ))}
        {status === "submitted" ? <Shimmer className="text-sm">Membaca Engine Host & knowledge base…</Shimmer> : null}
        {err ? <p className="text-sm text-warn" role="alert">{err}</p> : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
    <div className="mx-auto w-full max-w-3xl shrink-0 border-t border-border px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
      <PromptInput onSubmit={onSubmit}>
        <PromptInputTextarea ref={taRef} aria-label="Pesan untuk asisten" className="max-h-32 min-h-14 text-base" placeholder={scope === "KNOWLEDGE" ? "Tanya asisten…" : `Tanya kondisi ${SCOPE_LABEL[scope]}…`} />
        <PromptInputFooter className="justify-end">
          <PromptInputSubmit status={status} onStop={stop} aria-label={busy ? "Hentikan jawaban" : "Kirim pesan"} title={busy ? "Hentikan jawaban" : "Kirim pesan"} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  </>;
}
