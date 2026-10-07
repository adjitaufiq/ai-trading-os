CREATE TABLE public.assistant_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'Percakapan baru',
  symbol text,
  topic text NOT NULL DEFAULT 'GENERAL',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_threads TO authenticated;
GRANT ALL ON public.assistant_threads TO service_role;
ALTER TABLE public.assistant_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own threads select" ON public.assistant_threads FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own threads insert" ON public.assistant_threads FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own threads update" ON public.assistant_threads FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own threads delete" ON public.assistant_threads FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.assistant_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  sdk_id text NOT NULL,
  role text NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, sdk_id)
);
CREATE INDEX assistant_messages_thread_idx ON public.assistant_messages(thread_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_messages TO authenticated;
GRANT ALL ON public.assistant_messages TO service_role;
ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own msgs select" ON public.assistant_messages FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own msgs insert" ON public.assistant_messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.assistant_threads t WHERE t.id = thread_id AND t.user_id = auth.uid()));
CREATE POLICY "own msgs update" ON public.assistant_messages FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own msgs delete" ON public.assistant_messages FOR DELETE TO authenticated USING (auth.uid() = user_id);