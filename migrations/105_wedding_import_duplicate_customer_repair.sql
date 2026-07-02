-- Repair remaining wedding-import customer duplicates where the imported customer
-- matches existing customers by exact normalized first name, last name, and phone.
-- Prefer an existing store customer when present; otherwise prefer the existing
-- customer with the most transaction/payment history.

CREATE TEMP TABLE _wedding_import_customer_repair_105 AS
WITH normalized AS (
    SELECT
        c.id,
        c.customer_code,
        c.customer_created_source,
        c.created_at,
        LOWER(TRIM(COALESCE(c.first_name, ''))) AS first_key,
        LOWER(TRIM(COALESCE(c.last_name, ''))) AS last_key,
        CASE
            WHEN LENGTH(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) = 7
                THEN '716' || REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')
            WHEN LENGTH(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) = 10
                THEN REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')
            WHEN LENGTH(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) = 11
                 AND LEFT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 1) = '1'
                THEN SUBSTRING(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') FROM 2)
            ELSE NULL
        END AS phone10,
        (SELECT COUNT(*) FROM transactions t WHERE t.customer_id = c.id) AS transaction_count,
        (SELECT COUNT(*) FROM payment_transactions pt WHERE pt.payer_id = c.id) AS payment_count
    FROM customers c
),
ranked_matches AS (
    SELECT
        wi.id AS wedding_customer_id,
        ex.id AS existing_customer_id,
        ROW_NUMBER() OVER (
            PARTITION BY wi.id
            ORDER BY
                CASE WHEN ex.customer_created_source = 'store' THEN 0 ELSE 1 END,
                ex.transaction_count DESC,
                ex.payment_count DESC,
                ex.created_at ASC,
                ex.customer_code ASC
        ) AS match_rank
    FROM normalized wi
    JOIN normalized ex ON ex.id <> wi.id
    WHERE wi.customer_created_source = 'wedding_import'
      AND ex.customer_created_source <> 'wedding_import'
      AND wi.first_key <> ''
      AND wi.last_key <> ''
      AND wi.phone10 IS NOT NULL
      AND wi.first_key = ex.first_key
      AND wi.last_key = ex.last_key
      AND wi.phone10 = ex.phone10
)
SELECT wedding_customer_id, existing_customer_id
FROM ranked_matches
WHERE match_rank = 1;

-- If a duplicate wedding member for the same party/customer already exists, move
-- dependent records to the existing member before deleting the duplicate member.
WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE transactions t
SET wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE t.wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE payment_transactions pt
SET wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE pt.wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE alteration_orders ao
SET wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE ao.wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE wedding_appointments wa
SET wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE wa.wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE wedding_activity_log wal
SET wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE wal.wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE customer_open_deposit_ledger_sources src
SET payer_wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE src.payer_wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE customer_open_deposit_ledger_sources src
SET beneficiary_wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE src.beneficiary_wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE wedding_cutover_match_suggestions s
SET wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE s.wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id,
        existing_member.id AS existing_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
UPDATE wedding_non_inventory_items item
SET wedding_member_id = dm.existing_member_id
FROM duplicate_members dm
WHERE item.wedding_member_id = dm.duplicate_member_id;

WITH duplicate_members AS (
    SELECT
        wm.id AS duplicate_member_id
    FROM wedding_members wm
    JOIN _wedding_import_customer_repair_105 repair ON repair.wedding_customer_id = wm.customer_id
    JOIN wedding_members existing_member
      ON existing_member.wedding_party_id = wm.wedding_party_id
     AND existing_member.customer_id = repair.existing_customer_id
     AND existing_member.id <> wm.id
)
DELETE FROM wedding_members wm
USING duplicate_members dm
WHERE wm.id = dm.duplicate_member_id;

UPDATE wedding_members wm
SET
    customer_id = repair.existing_customer_id,
    customer_verified = TRUE
FROM _wedding_import_customer_repair_105 repair
WHERE wm.customer_id = repair.wedding_customer_id
  AND NOT EXISTS (
      SELECT 1
      FROM wedding_members existing_member
      WHERE existing_member.wedding_party_id = wm.wedding_party_id
        AND existing_member.customer_id = repair.existing_customer_id
        AND existing_member.id <> wm.id
  );

UPDATE wedding_appointments wa
SET customer_id = repair.existing_customer_id
FROM _wedding_import_customer_repair_105 repair
WHERE wa.customer_id = repair.wedding_customer_id;

DELETE FROM customers c
USING _wedding_import_customer_repair_105 repair
WHERE c.id = repair.wedding_customer_id
  AND NOT EXISTS (SELECT 1 FROM wedding_members wm WHERE wm.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM wedding_appointments wa WHERE wa.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.payer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM customer_timeline_notes n WHERE n.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM measurements m WHERE m.customer_id = c.id);
