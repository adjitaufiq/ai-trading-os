CREATE TABLE public.engine_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  m5_close_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  engine_state text,
  radar_status text,
  data_source text,
  regime text,
  horizon text[] NOT NULL DEFAULT '{}',
  approach text,
  bias text,
  market_phase text,
  h4_state text,
  h1_state text,
  setup text,
  decision text,
  confidence numeric,
  risk text,
  support numeric,
  resistance numeric,
  price numeric,
  invalidation text[] NOT NULL DEFAULT '{}',
  confirmation_needed text[] NOT NULL DEFAULT '{}',
  reasons text[] NOT NULL DEFAULT '{}',
  active_events text[] NOT NULL DEFAULT '{}',
  UNIQUE (symbol, m5_close_at)
);
CREATE INDEX engine_memory_symbol_time ON public.engine_memory (symbol, m5_close_at DESC);
CREATE INDEX engine_memory_match ON public.engine_memory (symbol, regime, decision);
GRANT SELECT ON public.engine_memory TO authenticated;
GRANT ALL ON public.engine_memory TO service_role;
ALTER TABLE public.engine_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signed-in read engine memory" ON public.engine_memory FOR SELECT TO authenticated USING (true);

CREATE TABLE public.engine_trades (
  trade_id text PRIMARY KEY,
  symbol text NOT NULL,
  direction text NOT NULL,
  result text NOT NULL,
  close_reason text,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL,
  profit_loss_usd numeric NOT NULL,
  risk_usd numeric NOT NULL,
  r_multiple numeric,
  failure_category text,
  data_source text,
  regime text,
  approach text,
  location text,
  trigger_pattern text,
  reaction_quality text,
  payload jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_trades_symbol_time ON public.engine_trades (symbol, opened_at DESC);
GRANT SELECT ON public.engine_trades TO authenticated;
GRANT ALL ON public.engine_trades TO service_role;
ALTER TABLE public.engine_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signed-in read engine trades" ON public.engine_trades FOR SELECT TO authenticated USING (true);

-- Append-only: history is never rewritten.
CREATE OR REPLACE FUNCTION public.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'engine history is append-only'; END $$;
CREATE TRIGGER engine_memory_immutable BEFORE UPDATE OR DELETE ON public.engine_memory FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();
CREATE TRIGGER engine_trades_immutable BEFORE UPDATE OR DELETE ON public.engine_trades FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();