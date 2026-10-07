ALTER TABLE public.execution_config DROP CONSTRAINT execution_config_max_open_positions_check;
ALTER TABLE public.execution_config ADD CONSTRAINT execution_config_max_open_positions_check CHECK (max_open_positions >= 1 AND max_open_positions <= 100000);
ALTER TABLE public.execution_config DROP CONSTRAINT execution_config_max_daily_trades_check;
ALTER TABLE public.execution_config ADD CONSTRAINT execution_config_max_daily_trades_check CHECK (max_daily_trades >= 1 AND max_daily_trades <= 1000000);
ALTER TABLE public.execution_config DROP CONSTRAINT execution_config_max_daily_loss_percent_check;
ALTER TABLE public.execution_config ADD CONSTRAINT execution_config_max_daily_loss_percent_check CHECK (max_daily_loss_percent > 0 AND max_daily_loss_percent <= 100);