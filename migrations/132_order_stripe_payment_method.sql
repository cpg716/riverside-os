-- Add stripe_payment_method_id column to orders for future payment processing on shipped orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR(255);

COMMENT ON COLUMN orders.stripe_payment_method_id IS 'Stripe payment method ID for charging shipped orders';