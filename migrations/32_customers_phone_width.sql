-- Legacy customers.phone was VARCHAR(20); formatted / international numbers exceed it (weddings import, CRM).
ALTER TABLE customers
    ALTER COLUMN phone TYPE VARCHAR(64)
    USING (CASE WHEN phone IS NULL THEN NULL ELSE LEFT(phone::text, 64) END);
