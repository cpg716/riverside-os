-- Riverside OS v0.70.7 — Staff Avatar Photo Upload Support
-- Adds real photo upload capability alongside existing SVG avatar_key system.
-- avatar_photo_url takes precedence when present; avatar_key remains fallback.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

ALTER TABLE public.staff
    ADD COLUMN avatar_photo_url text;

COMMENT ON COLUMN public.staff.avatar_photo_url IS
    'URL path to processed staff portrait photo (512x512 WebP/JPEG). Takes precedence over avatar_key when set.';

-- Index for fast lookup when rendering staff lists with photos
CREATE INDEX idx_staff_avatar_photo ON public.staff (id, avatar_photo_url)
    WHERE avatar_photo_url IS NOT NULL;
