ALTER TABLE public.loyalty_reward_issuances
    ADD COLUMN IF NOT EXISTS redemption_request_id uuid,
    ADD COLUMN IF NOT EXISTS balance_after integer;

CREATE UNIQUE INDEX IF NOT EXISTS loyalty_reward_issuances_redemption_request_id_uidx
    ON public.loyalty_reward_issuances (redemption_request_id)
    WHERE redemption_request_id IS NOT NULL;

COMMENT ON COLUMN public.loyalty_reward_issuances.redemption_request_id IS
    'Client-generated idempotency key that prevents duplicate point deductions and duplicate reward-card loads.';

COMMENT ON COLUMN public.loyalty_reward_issuances.balance_after IS
    'Customer loyalty-point balance returned by the original successful redemption request.';
