ALTER TABLE customers
    ALTER COLUMN marketing_email_opt_in SET DEFAULT true,
    ALTER COLUMN marketing_sms_opt_in SET DEFAULT true,
    ALTER COLUMN transactional_sms_opt_in SET DEFAULT true,
    ALTER COLUMN transactional_email_opt_in SET DEFAULT true;
