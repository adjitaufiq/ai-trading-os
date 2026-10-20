CREATE TABLE public.lab_report_runs (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null unique,
  trigger text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING',
  trade_rows integer,
  unique_trades integer,
  net_pnl numeric,
  first_trade_at timestamptz,
  last_trade_at timestamptz,
  file_bytes integer,
  telegram_status text,
  telegram_attempts integer not null default 0,
  note text
);
GRANT SELECT ON public.lab_report_runs TO authenticated;
GRANT ALL ON public.lab_report_runs TO service_role;
ALTER TABLE public.lab_report_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "operators read report runs" ON public.lab_report_runs FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));