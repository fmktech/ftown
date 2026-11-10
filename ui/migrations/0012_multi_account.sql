-- Multi-account server. Each account is an independent passkey-rooted ledger
-- (account_id = hash of its genesis record), so the server may hold many of
-- them. Drop the unique expression index that capped accounts at one row.
-- accounts.handle stays UNIQUE.
DROP INDEX IF EXISTS accounts_singleton;

-- The trusted checkpoint (the chain's checkpoint with the sticky revocations
-- applied), written in the same statement as the chain it describes. Auth reads
-- it instead of re-verifying the chain on every request. NULL for rows written
-- before this column existed: the server verifies those once and fills it in.
ALTER TABLE account_ledger ADD COLUMN IF NOT EXISTS checkpoint JSONB;
