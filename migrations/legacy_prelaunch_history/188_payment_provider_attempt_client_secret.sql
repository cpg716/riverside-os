-- Store short-lived provider validation secrets for hosted payment sessions.
-- These are not cardholder data and must never be returned to the client.

ALTER TABLE payment_provider_attempts
    ADD COLUMN IF NOT EXISTS provider_client_secret TEXT;

COMMENT ON COLUMN payment_provider_attempts.provider_client_secret IS
    'Short-lived hosted payment validation secret kept server-side only; never return to clients or logs.';
