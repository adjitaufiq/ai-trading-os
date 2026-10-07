-- Cloud control plane: configuration + observability only. No broker access lives here.
CREATE TABLE public.execution_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  execution_mode text NOT NULL DEFAULT 'REAL_DISABLED' CHECK (execution_mode IN ('PAPER_ONLY','DEMO_STRESS_TEST','REAL_DISABLED')),
  demo_enabled boolean NOT NULL DEFAULT false,
  risk_percent numeric NOT NULL DEFAULT 0.5 CHECK (risk_percent > 0 AND risk_percent <= 2),
  max_open_positions integer NOT NULL DEFAULT 1 CHECK (max_open_positions BETWEEN 1 AND 5),
  max_daily_loss_percent numeric NOT NULL DEFAULT 2 CHECK (max_daily_loss_percent > 0 AND max_daily_loss_percent <= 10),
  max_daily_trades integer NOT NULL DEFAULT 5 CHECK (max_daily_trades BETWEEN 1 AND 50),
  allowed_symbols text[] NOT NULL DEFAULT ARRAY['XAUUSD','BTCUSD'],
  kill_switch boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.execution_config TO authenticated;
GRANT ALL ON public.execution_config TO service_role;
ALTER TABLE public.execution_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_config FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read execution config" ON public.execution_config FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
INSERT INTO public.execution_config (id) VALUES (1);

CREATE TABLE public.execution_agent_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL UNIQUE,
  agent_online boolean NOT NULL DEFAULT false,
  last_heartbeat timestamptz,
  mt5_connected boolean NOT NULL DEFAULT false,
  account_mode text,
  account_number_masked text,
  broker_server text,
  execution_mode text,
  open_positions integer,
  current_version text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.execution_agent_status TO authenticated;
GRANT ALL ON public.execution_agent_status TO service_role;
ALTER TABLE public.execution_agent_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_agent_status FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read agent status" ON public.execution_agent_status FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));

CREATE TABLE public.execution_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT ON public.execution_audit_log TO authenticated;
GRANT ALL ON public.execution_audit_log TO service_role;
ALTER TABLE public.execution_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read execution audit" ON public.execution_audit_log FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE TRIGGER execution_audit_log_immutable BEFORE UPDATE OR DELETE ON public.execution_audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();
CREATE INDEX execution_audit_log_ts ON public.execution_audit_log ("timestamp" DESC);

-- Every config change is audited automatically (one row per changed concern).
CREATE OR REPLACE FUNCTION public.audit_execution_config_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE src text := coalesce(nullif(current_setting('app.change_source', true), ''), 'database');
BEGIN
  IF NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN
    INSERT INTO execution_audit_log(event_type, old_value, new_value, changed_by, source)
    VALUES ('MODE_CHANGED', to_jsonb(OLD.execution_mode), to_jsonb(NEW.execution_mode), NEW.updated_by, src);
  END IF;
  IF NEW.demo_enabled IS DISTINCT FROM OLD.demo_enabled THEN
    INSERT INTO execution_audit_log(event_type, old_value, new_value, changed_by, source)
    VALUES (CASE WHEN NEW.demo_enabled THEN 'DEMO_ENABLED' ELSE 'DEMO_DISABLED' END, to_jsonb(OLD.demo_enabled), to_jsonb(NEW.demo_enabled), NEW.updated_by, src);
  END IF;
  IF NEW.kill_switch IS DISTINCT FROM OLD.kill_switch THEN
    INSERT INTO execution_audit_log(event_type, old_value, new_value, changed_by, source)
    VALUES (CASE WHEN NEW.kill_switch THEN 'KILL_SWITCH_TRIGGERED' ELSE 'KILL_SWITCH_RELEASED' END, to_jsonb(OLD.kill_switch), to_jsonb(NEW.kill_switch), NEW.updated_by, src);
  END IF;
  IF (NEW.risk_percent, NEW.max_open_positions, NEW.max_daily_loss_percent, NEW.max_daily_trades) IS DISTINCT FROM
     (OLD.risk_percent, OLD.max_open_positions, OLD.max_daily_loss_percent, OLD.max_daily_trades) THEN
    INSERT INTO execution_audit_log(event_type, old_value, new_value, changed_by, source)
    VALUES ('RISK_CHANGED',
      jsonb_build_object('risk_percent', OLD.risk_percent, 'max_open_positions', OLD.max_open_positions, 'max_daily_loss_percent', OLD.max_daily_loss_percent, 'max_daily_trades', OLD.max_daily_trades),
      jsonb_build_object('risk_percent', NEW.risk_percent, 'max_open_positions', NEW.max_open_positions, 'max_daily_loss_percent', NEW.max_daily_loss_percent, 'max_daily_trades', NEW.max_daily_trades),
      NEW.updated_by, src);
  END IF;
  IF NEW.allowed_symbols IS DISTINCT FROM OLD.allowed_symbols THEN
    INSERT INTO execution_audit_log(event_type, old_value, new_value, changed_by, source)
    VALUES ('SYMBOLS_CHANGED', to_jsonb(OLD.allowed_symbols), to_jsonb(NEW.allowed_symbols), NEW.updated_by, src);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.audit_execution_config_change() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER execution_config_audit AFTER UPDATE ON public.execution_config FOR EACH ROW EXECUTE FUNCTION public.audit_execution_config_change();
CREATE TRIGGER execution_config_no_delete BEFORE DELETE ON public.execution_config FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();

-- Admin-only config mutation (the only write path; called by the dashboard server function as the signed-in user).
CREATE OR REPLACE FUNCTION public.update_execution_config(_patch jsonb)
RETURNS public.execution_config LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.execution_config;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('app.change_source', 'dashboard', true);
  UPDATE public.execution_config SET
    execution_mode = coalesce(_patch->>'execution_mode', execution_mode),
    demo_enabled = coalesce((_patch->>'demo_enabled')::boolean, demo_enabled),
    risk_percent = coalesce((_patch->>'risk_percent')::numeric, risk_percent),
    max_open_positions = coalesce((_patch->>'max_open_positions')::int, max_open_positions),
    max_daily_loss_percent = coalesce((_patch->>'max_daily_loss_percent')::numeric, max_daily_loss_percent),
    max_daily_trades = coalesce((_patch->>'max_daily_trades')::int, max_daily_trades),
    allowed_symbols = coalesce(ARRAY(SELECT jsonb_array_elements_text(_patch->'allowed_symbols')), allowed_symbols),
    kill_switch = coalesce((_patch->>'kill_switch')::boolean, kill_switch),
    updated_by = auth.uid(), updated_at = now()
  WHERE id = 1 RETURNING * INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.update_execution_config(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_execution_config(jsonb) TO authenticated;