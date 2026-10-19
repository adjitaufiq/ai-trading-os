CREATE TABLE public.lab_demo_trades (
  agent_id text NOT NULL,
  signal_id text NOT NULL,
  strategy text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  status text NOT NULL,
  ticket bigint,
  opened_at_ms bigint NOT NULL,
  closed_at_ms bigint,
  pnl_usd numeric,
  fingerprint text NOT NULL,
  snapshot_at_ms bigint NOT NULL,
  payload jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, signal_id)
);
GRANT SELECT ON public.lab_demo_trades TO authenticated;
GRANT ALL ON public.lab_demo_trades TO service_role;
ALTER TABLE public.lab_demo_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "operators read lab demo trades" ON public.lab_demo_trades FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE INDEX lab_demo_trades_opened_idx ON public.lab_demo_trades (opened_at_ms DESC);

CREATE TABLE public.lab_demo_events (
  agent_id text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  signal_id text,
  symbol text,
  strategy text,
  at_ms bigint,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, event_key)
);
GRANT SELECT ON public.lab_demo_events TO authenticated;
GRANT ALL ON public.lab_demo_events TO service_role;
ALTER TABLE public.lab_demo_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "operators read lab demo events" ON public.lab_demo_events FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE INDEX lab_demo_events_at_idx ON public.lab_demo_events (at_ms DESC);

CREATE TABLE public.lab_demo_sync_status (
  agent_id text PRIMARY KEY,
  runner_version text,
  armed boolean,
  phase text,
  reconciliation_clean boolean,
  block_reason text,
  snapshot_at_ms bigint NOT NULL,
  trades_count integer NOT NULL DEFAULT 0,
  last_received_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.lab_demo_sync_status TO authenticated;
GRANT ALL ON public.lab_demo_sync_status TO service_role;
ALTER TABLE public.lab_demo_sync_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "operators read lab demo sync" ON public.lab_demo_sync_status FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));