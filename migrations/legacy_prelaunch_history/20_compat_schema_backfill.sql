-- Compatibility backfill for older local databases that predate
-- wedding/session/customer schema columns now expected by the API.

ALTER TABLE wedding_parties
  ADD COLUMN IF NOT EXISTS party_name TEXT;

ALTER TABLE wedding_parties
  ADD COLUMN IF NOT EXISTS venue TEXT;

ALTER TABLE register_sessions
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'open';

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_vip BOOLEAN NOT NULL DEFAULT FALSE;
