-- Clean ROS-derived Counterpoint variation display labels without changing
-- Counterpoint source identity, SKUs, prices, stock, or product membership.
--
-- Counterpoint matrix keys can contain blank trailing dimensions such as
-- I-101583|BLACK||. Older ROS imports rendered those blanks as "*" in
-- variation_label, which made staff see fake options like BLACK / * / *.
-- Rebuild the display label from the nonblank Counterpoint key segments.

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
                      AND BTRIM(part) NOT IN ('*', '_')
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
