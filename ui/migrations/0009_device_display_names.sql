-- Additive cosmetic overrides; existing trust and bridge records remain unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS security_device_display_names (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'bridge')),
  target_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_id, kind, target_id)
);
