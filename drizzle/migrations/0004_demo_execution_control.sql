CREATE TABLE public.demo_execution_control (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  stopped boolean NOT NULL DEFAULT true,
  reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.demo_execution_control TO authenticated;
GRANT ALL ON public.demo_execution_control TO service_role;
ALTER TABLE public.demo_execution_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_execution_control FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read demo control" ON public.demo_execution_control FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE POLICY "operators update demo control" ON public.demo_execution_control FOR UPDATE TO authenticated USING (public.is_engine_operator(auth.uid())) WITH CHECK (public.is_engine_operator(auth.uid()) AND updated_by = auth.uid());
INSERT INTO public.demo_execution_control (id, stopped, reason) VALUES (1, true, 'initial: stopped until operator starts the demo lab') ON CONFLICT DO NOTHING;

CREATE TABLE public.demo_execution_control_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stopped boolean NOT NULL,
  reason text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.demo_execution_control_log TO authenticated;
GRANT ALL ON public.demo_execution_control_log TO service_role;
ALTER TABLE public.demo_execution_control_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_execution_control_log FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read demo control log" ON public.demo_execution_control_log FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));

CREATE OR REPLACE FUNCTION public.log_demo_control_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.demo_execution_control_log (stopped, reason, changed_by) VALUES (NEW.stopped, NEW.reason, NEW.updated_by);
  RETURN NEW;
END $$;
CREATE TRIGGER demo_control_audit AFTER UPDATE ON public.demo_execution_control FOR EACH ROW EXECUTE FUNCTION public.log_demo_control_change();
CREATE TRIGGER demo_control_log_immutable BEFORE UPDATE OR DELETE ON public.demo_execution_control_log FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();