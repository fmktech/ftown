-- Multi-account server. Each account is an independent passkey-rooted ledger
-- (account_id = hash of its genesis record), so the server may hold many of
-- them. Drop the unique expression index that capped accounts at one row.
-- accounts.handle stays UNIQUE.
DROP INDEX IF EXISTS accounts_singleton;
