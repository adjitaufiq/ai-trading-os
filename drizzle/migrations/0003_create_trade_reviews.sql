CREATE TABLE public.trade_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id text NOT NULL REFERENCES public.engine_trades(trade_id),
  review_version text NOT NULL,
  symbol text NOT NULL,
  compliance_status text NOT NULL,
  compliance jsonb NOT NULL,
  facts jsonb NOT NULL,
  narrative text NOT NULL,
  model text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_id, review_version)
);
GRANT SELECT ON public.trade_reviews TO authenticated;
GRANT ALL ON public.trade_reviews TO service_role;
ALTER TABLE public.trade_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read trade reviews" ON public.trade_reviews FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE TRIGGER trade_reviews_immutable BEFORE UPDATE OR DELETE ON public.trade_reviews FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();