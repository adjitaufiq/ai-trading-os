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
    allowed_symbols = CASE WHEN jsonb_typeof(_patch->'allowed_symbols') = 'array'
      THEN ARRAY(SELECT upper(btrim(x)) FROM jsonb_array_elements_text(_patch->'allowed_symbols') x WHERE btrim(x) <> '')
      ELSE allowed_symbols END,
    kill_switch = coalesce((_patch->>'kill_switch')::boolean, kill_switch),
    updated_by = auth.uid(), updated_at = now()
  WHERE id = 1 RETURNING * INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.update_execution_config(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_execution_config(jsonb) TO authenticated;