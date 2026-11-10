-- Multi-account server. Each account is an independent passkey-rooted ledger
-- (account_id = hash of its genesis record), so the server may hold many of
-- them. Drop the unique expression index that capped accounts at one row.
-- accounts.handle stays UNIQUE.
DROP INDEX IF EXISTS accounts_singleton;

-- The chain's RAW checkpoint (canonical JSON, no sticky revocations applied) and
-- an HMAC over it and the row's account_id, revision, head and sticky set, keyed
-- from AUTH_SECRET (which the database does not hold). Written in the same
-- statement as the chain. Auth trusts the checkpoint only when the MAC verifies;
-- otherwise (NULL for rows written before these columns, a rotated AUTH_SECRET,
-- an older instance, tampering) the server re-verifies the chain and rewrites them.
ALTER TABLE account_ledger ADD COLUMN IF NOT EXISTS checkpoint TEXT;
ALTER TABLE account_ledger ADD COLUMN IF NOT EXISTS checkpoint_mac TEXT;
