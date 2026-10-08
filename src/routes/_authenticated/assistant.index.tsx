import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Radar, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createThread, threadsQueryKey } from "@/lib/assistant/threads";


export const Route = createFileRoute("/_authenticated/assistant/")({
  component: AssistantHome,
  head: () => ({
    meta: [
      { title: "Chat Analis — Personal AI Trading OS" },
      {
        name: "description",
        content:
          "Percakapan asisten per simbol dan topik berdasarkan fakta Engine Host.",
      },
      { property: "og:title", content: "Chat Analis — Personal AI Trading OS" },
      {
        property: "og:description",
        content:
          "Chat analis pasar untuk menjelaskan kondisi engine tanpa mengubah keputusan trading.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function AssistantHome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (scope: string, topic: string) => {
    setBusy(true);
    setError(null);
    try {
      const thread = await createThread(scope, topic);
      await qc.invalidateQueries({ queryKey: threadsQueryKey });
      await navigate({ to: "/assistant/$threadId", params: { threadId: thread.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Percakapan belum bisa dibuka.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div className="flex flex-col items-center gap-3 py-3 text-center">
          <Radar className="size-10 text-bull" aria-hidden />
          <h2 className="text-lg font-semibold">Chat Analis</h2>
          <div className="grid w-full gap-2 sm:grid-cols-2">
            {(
              [
                ["XAUUSD", "RADAR", "Chat XAUUSD"],
                ["BTCUSD", "RADAR", "Chat BTCUSD"],
                ["ENGINE", "HEALTH", "Engine Host"],
                ["KNOWLEDGE", "REGIME", "Knowledge Base"],
              ] as const
            ).map(([scope, topic, label]) => (
              <Button
                key={scope}
                variant="outline"
                className="h-12 justify-start"
                disabled={busy}
                onClick={() => start(scope, topic)}
              >
                <MessageSquare className="text-bull" />
                {label}
              </Button>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-warn">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
