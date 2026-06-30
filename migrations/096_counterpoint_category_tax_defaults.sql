-- Counterpoint catalog categories are predominantly Clothing & Footwear for Riverside.
-- Treat obvious non-clothing/service categories as Regular; otherwise imported CP
-- category mappings should inherit the Clothing & Footwear NYS threshold rule.

WITH mapped AS (
    SELECT
        ccm.ros_category_id,
        bool_or(
            lower(coalesce(ccm.cp_category, '') || ' ' || coalesce(c.name, '')) ~
            '(alteration|aftershave|bag|cologne|cleaning|discount|fee|fragrance|freight|gift[ _-]?card|gift[ _-]?certificate|grooming|jewelry|misc|non[ _-]?clothing|payment|perfume|postage|rental|service|shipping|tax|toiletry|wallet|watch)'
        ) AS regular_taxable
    FROM counterpoint_category_map ccm
    INNER JOIN categories c ON c.id = ccm.ros_category_id
    WHERE ccm.ros_category_id IS NOT NULL
    GROUP BY ccm.ros_category_id
)
UPDATE categories c
SET is_clothing_footwear = NOT mapped.regular_taxable
FROM mapped
WHERE c.id = mapped.ros_category_id
  AND c.is_clothing_footwear IS DISTINCT FROM NOT mapped.regular_taxable;
