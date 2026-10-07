CREATE TABLE public.engine_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  symbol text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('RADAR','READY','BLOCKED','EXECUTION','EXIT')),
  stage text,
  signal_id text,
  occurred_at timestamptz NOT NULL,
  direction text,
  confidence numeric,
  timeframe_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  snapshot_ref text,
  entry numeric, stop_loss numeric, take_profit numeric,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_events_symbol_time ON public.engine_events (symbol, occurred_at DESC);
CREATE INDEX engine_events_signal ON public.engine_events (signal_id);
GRANT SELECT ON public.engine_events TO authenticated;
GRANT ALL ON public.engine_events TO service_role;
ALTER TABLE public.engine_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_events FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read engine events" ON public.engine_events FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE TRIGGER engine_events_immutable BEFORE UPDATE OR DELETE ON public.engine_events FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();

CREATE TABLE public.engine_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.engine_events(id),
  channel text NOT NULL DEFAULT 'TELEGRAM',
  delivery_status text NOT NULL CHECK (delivery_status IN ('PENDING','SENT','FAILED')),
  note text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_notifications_event ON public.engine_notifications (event_id, attempted_at DESC);
GRANT SELECT ON public.engine_notifications TO authenticated;
GRANT ALL ON public.engine_notifications TO service_role;
ALTER TABLE public.engine_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read notifications" ON public.engine_notifications FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE TRIGGER engine_notifications_immutable BEFORE UPDATE OR DELETE ON public.engine_notifications FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();