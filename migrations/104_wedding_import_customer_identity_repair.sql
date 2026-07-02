-- Normalize wedding-import customer identity:
-- - merge only unambiguous wedding-import duplicates into existing real customers
-- - format customer phones as (XXX) XXX-XXXX when digits are usable
-- - replace temporary Wedding-* customer codes with normal ROS customer codes

WITH wedding_import_customers AS (
    SELECT
        id,
        first_name,
        last_name,
        REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') AS phone_digits
    FROM customers
    WHERE customer_created_source = 'wedding_import'
      AND customer_code LIKE 'Wedding-%'
),
candidate_matches AS (
    SELECT
        wc.id AS wedding_customer_id,
        c.id AS existing_customer_id,
        COUNT(*) OVER (PARTITION BY wc.id) AS match_count
    FROM wedding_import_customers wc
    INNER JOIN customers c ON c.id <> wc.id
    WHERE c.customer_created_source <> 'wedding_import'
      AND LOWER(TRIM(COALESCE(c.first_name, ''))) = LOWER(TRIM(COALESCE(wc.first_name, '')))
      AND LOWER(TRIM(COALESCE(c.last_name, ''))) = LOWER(TRIM(COALESCE(wc.last_name, '')))
      AND wc.phone_digits <> ''
      AND (
          REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = wc.phone_digits
          OR (
              LENGTH(wc.phone_digits) = 7
              AND RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 7) = wc.phone_digits
          )
          OR (
              LENGTH(wc.phone_digits) = 10
              AND RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = wc.phone_digits
          )
      )
),
safe_matches AS (
    SELECT wedding_customer_id, existing_customer_id
    FROM candidate_matches
    WHERE match_count = 1
)
UPDATE wedding_members wm
SET
    customer_id = sm.existing_customer_id,
    customer_verified = TRUE
FROM safe_matches sm
WHERE wm.customer_id = sm.wedding_customer_id
  AND NOT EXISTS (
      SELECT 1
      FROM wedding_members existing_member
      WHERE existing_member.wedding_party_id = wm.wedding_party_id
        AND existing_member.customer_id = sm.existing_customer_id
  );

WITH wedding_import_customers AS (
    SELECT
        id,
        first_name,
        last_name,
        REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') AS phone_digits
    FROM customers
    WHERE customer_created_source = 'wedding_import'
      AND customer_code LIKE 'Wedding-%'
),
candidate_matches AS (
    SELECT
        wc.id AS wedding_customer_id,
        c.id AS existing_customer_id,
        COUNT(*) OVER (PARTITION BY wc.id) AS match_count
    FROM wedding_import_customers wc
    INNER JOIN customers c ON c.id <> wc.id
    WHERE c.customer_created_source <> 'wedding_import'
      AND LOWER(TRIM(COALESCE(c.first_name, ''))) = LOWER(TRIM(COALESCE(wc.first_name, '')))
      AND LOWER(TRIM(COALESCE(c.last_name, ''))) = LOWER(TRIM(COALESCE(wc.last_name, '')))
      AND wc.phone_digits <> ''
      AND (
          REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = wc.phone_digits
          OR (
              LENGTH(wc.phone_digits) = 7
              AND RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 7) = wc.phone_digits
          )
          OR (
              LENGTH(wc.phone_digits) = 10
              AND RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = wc.phone_digits
          )
      )
),
safe_matches AS (
    SELECT wedding_customer_id, existing_customer_id
    FROM candidate_matches
    WHERE match_count = 1
)
DELETE FROM customers c
USING safe_matches sm
WHERE c.id = sm.wedding_customer_id
  AND NOT EXISTS (SELECT 1 FROM wedding_members wm WHERE wm.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM wedding_appointments wa WHERE wa.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM payment_transactions pt WHERE pt.payer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM customer_timeline_notes n WHERE n.customer_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM measurements m WHERE m.customer_id = c.id);

WITH phone_digits AS (
    SELECT
        id,
        CASE
            WHEN LENGTH(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')) = 7
                THEN '716' || REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')
            WHEN LENGTH(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')) = 10
                THEN REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')
            WHEN LENGTH(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')) = 11
                 AND LEFT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 1) = '1'
                THEN SUBSTRING(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') FROM 2)
            ELSE NULL
        END AS normalized_digits
    FROM customers
    WHERE COALESCE(phone, '') <> ''
)
UPDATE customers c
SET phone = FORMAT(
    '(%s) %s-%s',
    SUBSTRING(pd.normalized_digits FROM 1 FOR 3),
    SUBSTRING(pd.normalized_digits FROM 4 FOR 3),
    SUBSTRING(pd.normalized_digits FROM 7 FOR 4)
)
FROM phone_digits pd
WHERE c.id = pd.id
  AND pd.normalized_digits IS NOT NULL
  AND c.phone IS DISTINCT FROM FORMAT(
      '(%s) %s-%s',
      SUBSTRING(pd.normalized_digits FROM 1 FOR 3),
      SUBSTRING(pd.normalized_digits FROM 4 FOR 3),
      SUBSTRING(pd.normalized_digits FROM 7 FOR 4)
  );

SELECT setval(
    'customer_code_seq',
    GREATEST(
        COALESCE((
            SELECT MAX((SUBSTRING(customer_code FROM '^ROS-([0-9]+)$'))::bigint)
            FROM customers
            WHERE customer_code ~ '^ROS-[0-9]+$'
        ), 0),
        (SELECT last_value FROM customer_code_seq)
    ),
    TRUE
);

UPDATE customers
SET customer_code = FORMAT('ROS-%s', LPAD(nextval('customer_code_seq')::text, 8, '0'))
WHERE customer_created_source = 'wedding_import'
  AND customer_code LIKE 'Wedding-%';
