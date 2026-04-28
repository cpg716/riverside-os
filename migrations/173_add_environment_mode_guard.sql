-- migrations/173_add_environment_mode_guard.sql
ALTER TABLE store_settings ADD COLUMN environment_mode text NOT NULL DEFAULT 'development';

-- Ensure it can only be one of the known modes
ALTER TABLE store_settings ADD CONSTRAINT environment_mode_check 
  CHECK (environment_mode IN ('development', 'production', 'e2e'));

-- Update existing row to development baseline
UPDATE store_settings SET environment_mode = 'development' WHERE id = 1;
