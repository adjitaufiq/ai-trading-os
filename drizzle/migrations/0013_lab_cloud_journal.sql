CREATE TABLE public.lab_journal_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'BROWSER_PAPER' CHECK (source = 'BROWSER_PAPER'),
  started_at_ms bigint,
  initial_balance numeric NOT NULL DEFAULT 500,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_as_of_ms bigint NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
GRANT SELECT, INSERT, UPDATE ON public.lab_journal_sessions TO authenticated;
GRANT ALL ON public.lab_journal_sessions TO service_role;
ALTER TABLE public.lab_journal_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads lab sessions" ON public.lab_journal_sessions FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "owner inserts lab sessions" ON public.lab_journal_sessions FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "owner updates lab sessions" ON public.lab_journal_sessions FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE TABLE public.lab_journal_trades (
  session_id uuid NOT NULL,
  user_id uuid NOT NULL,
  trade_id text NOT NULL,
  strategy text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  pnl_usd numeric NOT NULL,
  opened_at_ms bigint NOT NULL,
  closed_at_ms bigint,
  revision bigint NOT NULL,
  payload jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, trade_id),
  FOREIGN KEY (session_id, user_id) REFERENCES public.lab_journal_sessions (id, user_id)
);
GRANT SELECT, INSERT, UPDATE ON public.lab_journal_trades TO authenticated;
GRANT ALL ON public.lab_journal_trades TO service_role;
ALTER TABLE public.lab_journal_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads lab trades" ON public.lab_journal_trades FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "owner inserts lab trades" ON public.lab_journal_trades FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "owner updates lab trades" ON public.lab_journal_trades FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE INDEX lab_journal_trades_owner_time ON public.lab_journal_trades (user_id, opened_at_ms DESC);
CREATE FUNCTION public.protect_lab_journal_revision() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.session_id <> OLD.session_id OR NEW.trade_id <> OLD.trade_id THEN
    RAISE EXCEPTION 'journal identity is immutable';
  END IF;
  IF NEW.revision <= OLD.revision OR OLD.status = 'CLOSED' THEN RETURN NULL; END IF;
  NEW.synced_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER lab_journal_revision_guard BEFORE UPDATE ON public.lab_journal_trades FOR EACH ROW EXECUTE FUNCTION public.protect_lab_journal_revision();
COMMENT ON TABLE public.lab_journal_trades IS 'Browser PAPER simulation journal only. Not MT5 deals; P/L is estimated. Missing historical observations remain unknown.';