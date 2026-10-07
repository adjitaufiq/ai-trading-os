import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Radar } from "lucide-react";
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
    <header className="flex items-center gap-2 border-b border-border px-4 py-2">
      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground">{SCOPE_LABEL[scope]}</span>
      <span className="text-xs text-muted-foreground">{TOPIC_LABEL[thread.topic] ?? thread.topic}</span>
      {scope === "XAUUSD" || scope === "BTCUSD" ? (
        <button onClick={() => send(briefingPrompt(scope))} disabled={busy} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50">
          <FileText className="size-3" /> Session Brief
        </button>
      ) : null}
      <span className="ml-auto text-[10px] text-muted-foreground">Sumber fakta: ENGINE HOST VPS · AI hanya menjelaskan</span>
    </header>
    <Conversation className="flex-1">
      <ConversationContent className="mx-auto w-full max-w-3xl">
        {messages.length === 0 ? (
          <ConversationEmptyState icon={<Radar className="size-8 text-bull" />} title={`Thread ${SCOPE_LABEL[scope]}`}
            description="Tanya arti istilah engine atau kondisi Radar saat ini.">
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {(SUGGESTIONS[scope] ?? []).map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-accent">{s}</button>
              ))}
            </div>
          </ConversationEmptyState>
        ) : messages.map((m) => (
          <Message key={m.id} from={m.role}>
            <MessageContent>
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
    <div className="mx-auto w-full max-w-3xl p-3">
      <PromptInput onSubmit={onSubmit}>
        <PromptInputTextarea ref={taRef} placeholder={scope === "KNOWLEDGE" ? "Tanya arti istilah… (mis. Apa arti TRANSITION?)" : `Tanya kondisi ${SCOPE_LABEL[scope]} sekarang…`} />
        <PromptInputFooter className="justify-end">
          <PromptInputSubmit status={status} onStop={stop} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  </>;
}
