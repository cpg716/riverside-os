-- Customer-level opt-out for Podium review requests.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS review_requests_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN customers.review_requests_opt_out IS 'When TRUE, Podium review invites will never be sent for this customer regardless of sale status.';

CREATE INDEX IF NOT EXISTS idx_customers_review_requests_opt_out
    ON customers (review_requests_opt_out)
    WHERE review_requests_opt_out = TRUE;
