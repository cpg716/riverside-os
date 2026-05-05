-- Track dated customer profile links so history remains shared only for the linked period.

CREATE TABLE IF NOT EXISTS customer_relationship_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    child_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    unlinked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT customer_relationship_periods_distinct_profiles
        CHECK (parent_customer_id <> child_customer_id),
    CONSTRAINT customer_relationship_periods_valid_range
        CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_relationship_open_parent
    ON customer_relationship_periods (parent_customer_id)
    WHERE unlinked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_relationship_open_child
    ON customer_relationship_periods (child_customer_id)
    WHERE unlinked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customer_relationship_parent_range
    ON customer_relationship_periods (parent_customer_id, linked_at DESC, unlinked_at);

CREATE INDEX IF NOT EXISTS idx_customer_relationship_child_range
    ON customer_relationship_periods (child_customer_id, linked_at DESC, unlinked_at);

INSERT INTO customer_relationship_periods (
    parent_customer_id,
    child_customer_id,
    linked_at
)
SELECT
    c.couple_primary_id,
    c.id,
    COALESCE(c.couple_linked_at, now())
FROM customers c
WHERE c.couple_id IS NOT NULL
  AND c.couple_primary_id IS NOT NULL
  AND c.id <> c.couple_primary_id
ON CONFLICT DO NOTHING;
