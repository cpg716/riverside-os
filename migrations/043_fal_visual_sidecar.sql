-- Riverside OS v0.70.8 — Fal.ai Visual Sidecar Integration
-- Supports tracking asynchronous image generation jobs for staff avatars, products, and promo images.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

CREATE TABLE IF NOT EXISTS public.fal_generation_jobs (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    job_type TEXT NOT NULL CHECK (job_type IN ('staff_avatar', 'product_image', 'promo_image')),
    target_id UUID NOT NULL, -- staff_id, product_id, or Uuid::nil() (for new products)
    pending_job_id TEXT, -- Fal.ai request_id
    local_asset_path TEXT, -- Local path under /client/public/fal/
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_fal_generation_jobs_pending_id ON public.fal_generation_jobs(pending_job_id);

COMMENT ON TABLE public.fal_generation_jobs IS 'Visual asset generation tasks dispatched to Fal.ai and handled locally';
