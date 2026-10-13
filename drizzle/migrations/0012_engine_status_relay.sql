CREATE TABLE public.engine_status_relay (
  agent_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);
GRANT ALL ON public.engine_status_relay TO service_role;
ALTER TABLE public.engine_status_relay ENABLE ROW LEVEL SECURITY;
-- No policies: only server-side code (service role) reads/writes; public reads go through a sanitized server route.