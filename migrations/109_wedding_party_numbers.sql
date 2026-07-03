ALTER TABLE wedding_parties
    ADD COLUMN IF NOT EXISTS wedding_number TEXT;

CREATE OR REPLACE FUNCTION wedding_number_base(groom_name TEXT, event_date DATE)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    WITH cleaned AS (
        SELECT NULLIF(TRIM(regexp_replace(UPPER(COALESCE(groom_name, '')), '[^A-Z0-9]+', ' ', 'g')), '') AS name
    )
    SELECT COALESCE(
        NULLIF(regexp_replace(COALESCE(name, ''), '^.* ', ''), ''),
        'WEDDING'
    ) || '-' || to_char(event_date, 'MMDDYY')
    FROM cleaned;
$$;

CREATE OR REPLACE FUNCTION wedding_number_suffix(n INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    value INTEGER := n;
    result TEXT := '';
BEGIN
    IF value <= 0 THEN
        RETURN '';
    END IF;

    WHILE value > 0 LOOP
        value := value - 1;
        result := chr(65 + (value % 26)) || result;
        value := value / 26;
    END LOOP;

    RETURN result;
END;
$$;

WITH ranked AS (
    SELECT
        id,
        wedding_number_base(groom_name, event_date) AS base_number,
        ROW_NUMBER() OVER (
            PARTITION BY wedding_number_base(groom_name, event_date)
            ORDER BY event_date, created_at, id
        ) AS ordinal
    FROM wedding_parties
)
UPDATE wedding_parties wp
SET wedding_number = ranked.base_number || wedding_number_suffix((ranked.ordinal - 1)::INTEGER)
FROM ranked
WHERE wp.id = ranked.id
  AND (wp.wedding_number IS NULL OR TRIM(wp.wedding_number) = '');

CREATE UNIQUE INDEX IF NOT EXISTS wedding_parties_wedding_number_key
    ON wedding_parties (wedding_number)
    WHERE wedding_number IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_wedding_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    base_number TEXT;
    candidate TEXT;
    ordinal INTEGER := 0;
BEGIN
    base_number := wedding_number_base(NEW.groom_name, NEW.event_date);

    LOOP
        candidate := base_number || wedding_number_suffix(ordinal);
        EXIT WHEN NOT EXISTS (
            SELECT 1
            FROM wedding_parties existing
            WHERE existing.wedding_number = candidate
              AND existing.id IS DISTINCT FROM NEW.id
        );
        ordinal := ordinal + 1;
    END LOOP;

    NEW.wedding_number := candidate;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wedding_parties_assign_wedding_number ON wedding_parties;

CREATE TRIGGER wedding_parties_assign_wedding_number
BEFORE INSERT OR UPDATE OF groom_name, event_date, wedding_number
ON wedding_parties
FOR EACH ROW
EXECUTE FUNCTION assign_wedding_number();
