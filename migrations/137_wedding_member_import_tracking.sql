-- Migration 137: Wedding member import tracking fields
-- Tracks import-sourced members and verification status

ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS customer_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS import_customer_name TEXT;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS import_customer_phone TEXT;

COMMENT ON COLUMN wedding_members.customer_verified IS 'TRUE when this member has been matched to an existing ROS customer';
COMMENT ON COLUMN wedding_members.import_customer_name IS 'Original customer name from import (before ROS link)';
COMMENT ON COLUMN wedding_members.import_customer_phone IS 'Original customer phone from import (before ROS link)';