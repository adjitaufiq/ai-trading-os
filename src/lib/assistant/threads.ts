// Browser-side thread store (RLS-scoped to the signed-in user).
import type { UIMessage } from "ai";
import { supabase } from "@/integrations/supabase/client";

export interface AssistantThread { id: string; title: string; symbol: string | null; topic: string; updated_at: string }

export const threadsQueryKey = ["assistant-threads"] as const;

export async function listThreads(): Promise<AssistantThread[]> {
  const { data, error } = await supabase.from("assistant_threads").select("id, title, symbol, topic, updated_at").order("updated_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function createThread(scope: string, topic: string): Promise<AssistantThread> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error("Belum login");
  const { data, error } = await supabase.from("assistant_threads")
    .insert({ user_id: u.user.id, symbol: scope, topic })
    .select("id, title, symbol, topic, updated_at").single();
  if (error) throw error;
  return data;
}

export async function deleteThread(id: string) {
  const { error } = await supabase.from("assistant_threads").delete().eq("id", id);
  if (error) throw error;
}

export async function loadThread(id: string): Promise<{ thread: AssistantThread | null; messages: UIMessage[] }> {
  const [t, m] = await Promise.all([
    supabase.from("assistant_threads").select("id, title, symbol, topic, updated_at").eq("id", id).maybeSingle(),
    supabase.from("assistant_messages").select("sdk_id, role, parts").eq("thread_id", id).order("created_at"),
  ]);
  if (t.error) throw t.error;
  if (m.error) throw m.error;
  return {
    thread: t.data,
    messages: m.data.map((r) => ({ id: r.sdk_id, role: r.role as UIMessage["role"], parts: r.parts as unknown as UIMessage["parts"] })),
  };
}
