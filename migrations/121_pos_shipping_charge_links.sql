-- Link Register-collected shipping charges to existing Transaction Records they cover.
-- The shipping revenue remains on the charge transaction via transactions.shipping_amount_usd.

CREATE TABLE IF NOT EXISTS public.pos_shipping_charge_links (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    shipping_transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
    target_transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    shipment_id uuid REFERENCES public.shipment(id) ON DELETE SET NULL,
    amount_usd numeric(12,2) NOT NULL DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT pos_shipping_charge_links_pkey PRIMARY KEY (id),
    CONSTRAINT pos_shipping_charge_links_amount_nonnegative CHECK (amount_usd >= 0),
    CONSTRAINT pos_shipping_charge_links_distinct_tx CHECK (shipping_transaction_id <> target_transaction_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_shipping_charge_links_pair_uidx
    ON public.pos_shipping_charge_links (shipping_transaction_id, target_transaction_id);

CREATE INDEX IF NOT EXISTS idx_pos_shipping_charge_links_target
    ON public.pos_shipping_charge_links (target_transaction_id);

COMMENT ON TABLE public.pos_shipping_charge_links IS
    'Auditable links from a Register shipping-charge Transaction Record to existing customer Transaction Records whose delivery the charge covers.';
