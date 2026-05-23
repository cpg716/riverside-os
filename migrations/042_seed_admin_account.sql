-- Riverside OS — Seed default admin account
-- Creates the bootstrap admin user for fresh installs.
-- On conflict, preserves existing account but ensures role is admin and active.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

INSERT INTO public.staff (
    full_name,
    cashier_code,
    pin_hash,
    role,
    is_active,
    base_commission_rate,
    max_discount_percent,
    avatar_key
)
VALUES (
    'Chris G',
    '1234',
    '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc',
    'admin'::public.staff_role,
    TRUE,
    0.0200,
    30,
    'ros_default'
)
ON CONFLICT (cashier_code) DO UPDATE
SET
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    pin_hash = EXCLUDED.pin_hash,
    is_active = TRUE;

