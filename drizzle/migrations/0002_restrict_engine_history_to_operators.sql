CREATE TYPE public.app_role AS ENUM ('admin', 'operator', 'user');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own roles select" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.is_engine_operator(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('admin','operator'))
$$;
REVOKE EXECUTE ON FUNCTION public.is_engine_operator(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.is_engine_operator(uuid) TO authenticated;

DROP POLICY IF EXISTS "signed-in read engine memory" ON public.engine_memory;
DROP POLICY IF EXISTS "signed-in read engine trades" ON public.engine_trades;
REVOKE ALL ON public.engine_memory FROM anon;
REVOKE ALL ON public.engine_trades FROM anon;
ALTER TABLE public.engine_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_memory FORCE ROW LEVEL SECURITY;
ALTER TABLE public.engine_trades FORCE ROW LEVEL SECURITY;
CREATE POLICY "operators read engine memory" ON public.engine_memory FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));
CREATE POLICY "operators read engine trades" ON public.engine_trades FOR SELECT TO authenticated USING (public.is_engine_operator(auth.uid()));