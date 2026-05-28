-- Set operational SMS/Email opt-ins to true for all existing customers
-- This ensures all customers receive operational messages (pickup, alterations, appointments, etc.)
-- Promotional opt-ins remain as-is to respect customer preferences

UPDATE customers
SET transactional_sms_opt_in = true
WHERE transactional_sms_opt_in = false;

UPDATE customers
SET transactional_email_opt_in = true
WHERE transactional_email_opt_in = false;
