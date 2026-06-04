-- Add verify_completed status to alteration_status enum
-- This allows staff to verify alterations are complete before marking ready for pickup

-- Add new status to the enum
ALTER TYPE public.alteration_status ADD VALUE IF NOT EXISTS 'verify_completed' AFTER 'in_work';

-- Add comment for documentation
COMMENT ON TYPE public.alteration_status IS 'Alteration workflow statuses: intake, in_work, verify_completed (staff verifies work is done), ready (ready for pickup), picked_up';
