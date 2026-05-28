-- Daily Financial Report configuration and storage.
-- After daily close, an automated financial summary is generated, stored, and emailed.

-- Configuration column on store_settings
ALTER TABLE store_settings
ADD COLUMN IF NOT EXISTS daily_report_config jsonb DEFAULT '{}'::jsonb;

-- Stored daily financial reports
CREATE TABLE IF NOT EXISTS daily_financial_reports (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL PRIMARY KEY,
    report_date date NOT NULL,
    generated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    generated_by uuid REFERENCES staff(id),
    report_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    html_content text,
    sent_at timestamptz,
    sent_to text[],
    send_error text,
    is_test boolean DEFAULT false,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_daily_financial_reports_date
    ON daily_financial_reports (report_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_financial_reports_date_non_test
    ON daily_financial_reports (report_date)
    WHERE is_test = false;
