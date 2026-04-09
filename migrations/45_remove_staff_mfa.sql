-- Drop TOTP/MFA (product choice: staff PIN + RBAC only).

DROP TABLE IF EXISTS staff_mfa_sessions;

ALTER TABLE staff DROP COLUMN IF EXISTS mfa_totp_secret;
ALTER TABLE staff DROP COLUMN IF EXISTS mfa_enabled;
