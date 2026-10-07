-- Tighten grants: history tables are read-only for signed-in roles (RLS limits to operators); no anon.
REVOKE ALL ON public.engine_memory, public.engine_trades, public.trade_reviews FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.engine_memory, public.engine_trades, public.trade_reviews FROM authenticated;
GRANT SELECT ON public.engine_memory, public.engine_trades, public.trade_reviews TO authenticated;
GRANT ALL ON public.engine_memory, public.engine_trades, public.trade_reviews TO service_role;

-- Append-only audit of privileged access.
CREATE TABLE public.engine_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_role text NOT NULL,
  action text NOT NULL,
  scope text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.engine_access_audit TO authenticated;
GRANT ALL ON public.engine_access_audit TO service_role;
ALTER TABLE public.engine_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_access_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read access audit" ON public.engine_access_audit FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE TRIGGER engine_access_audit_immutable BEFORE UPDATE OR DELETE ON public.engine_access_audit FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();

-- Operators record their reads; non-operators are rejected (and cannot read anyway).
CREATE OR REPLACE FUNCTION public.log_engine_access(_scope text, _detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_engine_operator(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  INSERT INTO public.engine_access_audit (actor_id, actor_role, action, scope, detail)
  VALUES (auth.uid(), 'operator', 'READ', left(_scope, 80), coalesce(_detail, '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.log_engine_access(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_engine_access(text, jsonb) TO authenticated;

-- Every privileged write to history is traced automatically.
CREATE OR REPLACE FUNCTION public.audit_engine_history_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.engine_access_audit (actor_id, actor_role, action, scope, detail)
  VALUES (auth.uid(), coalesce(nullif(auth.role(), ''), current_user), 'INSERT', TG_TABLE_NAME,
          jsonb_build_object('key', coalesce(to_jsonb(NEW)->>'trade_id', to_jsonb(NEW)->>'id')));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.audit_engine_history_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER engine_memory_audit AFTER INSERT ON public.engine_memory FOR EACH ROW EXECUTE FUNCTION public.audit_engine_history_write();
CREATE TRIGGER engine_trades_audit AFTER INSERT ON public.engine_trades FOR EACH ROW EXECUTE FUNCTION public.audit_engine_history_write();
CREATE TRIGGER trade_reviews_audit AFTER INSERT ON public.trade_reviews FOR EACH ROW EXECUTE FUNCTION public.audit_engine_history_write();