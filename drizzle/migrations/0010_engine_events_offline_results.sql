ALTER TABLE public.engine_events DROP CONSTRAINT IF EXISTS engine_events_event_type_check;
ALTER TABLE public.engine_events ADD CONSTRAINT engine_events_event_type_check CHECK (event_type IN ('RADAR','READY','BLOCKED','EXECUTION','EXIT','ENGINE_OFFLINE','ENGINE_ONLINE'));
ALTER TABLE public.engine_events ADD COLUMN IF NOT EXISTS execution_result text;
ALTER TABLE public.engine_events ADD COLUMN IF NOT EXISTS block_reason text;
ALTER TABLE public.engine_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'capture';