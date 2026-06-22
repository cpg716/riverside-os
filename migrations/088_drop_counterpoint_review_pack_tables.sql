-- Retire the pre-go-live Counterpoint review-pack tables.
-- The active Counterpoint path is direct Bridge -> Main Hub ROS import proof,
-- exceptions, duplicate review, and final sign-off.

DROP TABLE IF EXISTS public.counterpoint_ai_review_suggestions;
DROP TABLE IF EXISTS public.counterpoint_ai_review_imports;
DROP TABLE IF EXISTS public.counterpoint_review_pack_rows;
DROP TABLE IF EXISTS public.counterpoint_review_packs;
