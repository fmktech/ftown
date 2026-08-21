-- Rate limiter state is throwaway security bookkeeping: UNLOGGED skips WAL for
-- much cheaper upserts on the hot login/register path. Accepted trade-off: the
-- table is truncated after crash recovery and is not replicated.
ALTER TABLE rate_limit_attempts SET UNLOGGED;
