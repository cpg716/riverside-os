-- Follow-up to 106: some Counterpoint matrix placeholder dimensions are "**"
-- rather than "*". Treat any all-star/all-underscore segment as display-only
-- placeholder text and rebuild the ROS label from real key segments only.

WITH cleaned AS (
    SELECT
        pv.id,
        NULLIF(
            ARRAY_TO_STRING(
                ARRAY(
                    SELECT BTRIM(part)
                    FROM UNNEST(STRING_TO_ARRAY(pv.counterpoint_item_key, '|')) WITH ORDINALITY AS key_part(part, ord)
                    WHERE ord > 1
                      AND BTRIM(part) <> ''
                      AND BTRIM(part) !~ '^[*_]+$'
                ),
                ' / '
            ),
            ''
        ) AS clean_label
    FROM product_variants pv
    WHERE NULLIF(BTRIM(COALESCE(pv.counterpoint_item_key, '')), '') IS NOT NULL
      AND pv.counterpoint_item_key LIKE '%|%'
)
UPDATE product_variants pv
SET variation_label = cleaned.clean_label
FROM cleaned
WHERE cleaned.id = pv.id
  AND cleaned.clean_label IS NOT NULL
  AND pv.variation_label IS DISTINCT FROM cleaned.clean_label;
