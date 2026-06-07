-- Allow storewide discount events for full-inventory promotions.

ALTER TABLE public.discount_events
    DROP CONSTRAINT IF EXISTS discount_events_scope_chk;

ALTER TABLE public.discount_events
    ADD CONSTRAINT discount_events_scope_chk CHECK (
        (
            scope_type = ANY (
                ARRAY[
                    'variants'::text,
                    'all'::text,
                    'category'::text,
                    'vendor'::text
                ]
            )
        )
        AND (
            (
                scope_type = 'variants'::text
                AND scope_category_id IS NULL
                AND scope_vendor_id IS NULL
            )
            OR (
                scope_type = 'all'::text
                AND scope_category_id IS NULL
                AND scope_vendor_id IS NULL
            )
            OR (
                scope_type = 'category'::text
                AND scope_category_id IS NOT NULL
                AND scope_vendor_id IS NULL
            )
            OR (
                scope_type = 'vendor'::text
                AND scope_vendor_id IS NOT NULL
                AND scope_category_id IS NULL
            )
        )
    );
