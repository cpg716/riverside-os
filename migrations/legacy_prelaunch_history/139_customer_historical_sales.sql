-- Add historical lifetime sales column to customers table for Counterpoint data parity
ALTER TABLE customers ADD COLUMN sales_lifetime_historical numeric(12, 2) DEFAULT 0;
