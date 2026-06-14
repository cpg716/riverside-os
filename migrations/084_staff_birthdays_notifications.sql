-- Staff birthday month/day and one-per-day greeting acknowledgment.

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS birthday_month SMALLINT,
    ADD COLUMN IF NOT EXISTS birthday_day SMALLINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'staff_birthday_pair_valid'
    ) THEN
        BEGIN
            ALTER TABLE staff
                ADD CONSTRAINT staff_birthday_pair_valid
                CHECK (
                    (birthday_month IS NULL AND birthday_day IS NULL)
                    OR (birthday_month IS NOT NULL AND birthday_day IS NOT NULL)
                );
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'staff_birthday_calendar_valid'
    ) THEN
        BEGIN
            ALTER TABLE staff
                ADD CONSTRAINT staff_birthday_calendar_valid
                CHECK (
                    birthday_month IS NULL
                    OR birthday_day IS NULL
                    OR (
                        birthday_month BETWEEN 1 AND 12
                        AND birthday_day BETWEEN 1 AND 31
                        AND (
                            (birthday_month IN (1, 3, 5, 7, 8, 10, 12) AND birthday_day <= 31)
                            OR (birthday_month IN (4, 6, 9, 11) AND birthday_day <= 30)
                            OR (birthday_month = 2 AND birthday_day <= 29)
                        )
                    )
                );
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS staff_birthday_popup_seen (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    birthday_local_date DATE NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (staff_id, birthday_local_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_birthday_popup_seen_staff_date
    ON staff_birthday_popup_seen(staff_id, birthday_local_date);
