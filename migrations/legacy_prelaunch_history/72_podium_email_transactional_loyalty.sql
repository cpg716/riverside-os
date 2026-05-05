-- Operational email consent (Podium) + optional staff-pasted Podium conversation link on customer profile.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS transactional_email_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS podium_conversation_url TEXT;

COMMENT ON COLUMN customers.transactional_email_opt_in IS 'Consent for transactional email (pickup, alterations, appointments, loyalty notices) via Podium; combined with marketing_email_opt_in in messaging rules.';
COMMENT ON COLUMN customers.podium_conversation_url IS 'Optional staff-pasted link to Podium conversation (until API thread sync).';
