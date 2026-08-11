# Daily Financial Report

## Overview

The Daily Financial Report is an automated system that generates, stores, and emails a comprehensive financial summary at the end of each business day. Its headline daily and month-to-date figures use canonical **booked Daily Sales**, matching the ROS Today's Sales card and booked Register report. The body separately discloses recognized revenue, business-day weather, tenders, tax, returns, deposits, gift cards, alterations, inventory receiving, supplier inbound freight, category margins, and QBO journal status. Alteration charges are included in the applicable sales basis and are also disclosed separately. Shipping is disclosed separately and is excluded from sales totals and commissions.

Reports are generated after the register Z-close and can be viewed, resent, or test-sent from the Settings panel.

## Configuration

**Settings → Daily Financial Report** (requires `settings.admin`)

| Setting | Default | Description |
|---------|---------|-------------|
| **Enable Daily Financial Report** | Off | Master toggle for generation and storage |
| **Auto-Send After Close** | On | Email the report automatically after Z-close |
| **Include QuickBooks Status** | On | Show QBO journal sync status in the report |
| **Include Inventory Activity** | On | Show receiving and supplier inbound freight activity |
| **Email Subject Template** | `Riverside OS — Daily Financial Report — {date}` | `{date}` placeholder replaced with business date |
| **Recipient Email Addresses** | _(empty)_ | List of email addresses to receive the report |

## Report Content

Each daily report includes:

### Key Metrics
- **Booked Net Sales** — canonical pre-tax booking-event net sales, including reportable later amendments and same-day returns, matching ROS Daily Sales
- **Booked Sales Count** — unique booked sales reported by the canonical Daily Sales summary
- **Average Booked Sale** — booked net sales ÷ booked sales count
- **MTD Booked Net** — booked net sales from the first day of the report month through the report date
- **Last Year MTD** — the prior-year booked-net baseline for the exact comparison window
- **MTD vs Last Year** — signed dollar difference and percentage difference together; the percentage is shown as `N/A` when the prior-year net baseline is zero

Headline cards, the Booked Sales Summary, and MTD comparisons use the booking-event business date. Recognized Revenue Detail, recognized item/discount figures, and recognized tax use the fulfillment/recognition date. Payment Methods and Total Tendered use the payment processing date. These are separate ledgers and are not expected to equal each other. Booked Daily Sales, recognized revenue, deposits, and processed tender must never be substituted for one another.

### Month-to-Date Net Comparison

- Current MTD and prior-year MTD call the same canonical booked Daily Sales summary used by the daily **Booked Net Sales** figure.
- Period totals preserve each source-dated business day's booked activity before summing the window; later activity on the same Transaction Record cannot net away an earlier day's booked result.
- The comparison always ends on the report business date, not the email-send date.
- The prior-year window uses the same month and day numbers. For a February 29 report, a non-leap prior year ends on February 28.
- The body lists both exact date windows, both net values, the signed dollar change, and the signed percentage change.

### Business Day Weather

- Shows condition, high/low temperature in Fahrenheit, and precipitation in inches from the stored Visual Crossing snapshot for the report business date.
- The report labels whether the row is a Register-close snapshot or a finalized historical observation.
- Simulated/mock weather is never presented as actual data in a financial report. If no explicitly sourced Visual Crossing row is available, the weather section says actual weather was unavailable.

### Booked Sales Summary

- Booked net sales, booked tax, total with tax, booked sales count, and average booked sale from the canonical booked Daily Sales source.

### Recognized Revenue Detail

- Recognized gross sales, discounts, net sales, and items sold. Discounts include POS price
  overrides, customer profile discounts, employee prices, and explicit discount
  amounts while keeping recognized net sales on the final line price.

### Recognized Tax
- State tax, local tax, total tax

### Returns
- Return line count, return value (shown only when > 0)

### Payment Methods
- Breakdown by tender type (Credit/Debit Card, Cash, Gift Card, Store Credit, Deposit Applied, RMS Charge, etc.)
- Amount and transaction count per method
- Total tendered

### Gift Cards
- Cards sold (count + value), cards redeemed (shown only when > 0)
- **Gift Card Breakage (v0.3.5+)** — Sweeps expired purchased gift cards, reducing their balance to zero, updating status to depleted, and staging the unredeemed liability as breakage revenue (debiting liability, crediting breakage income) in QBO.

### Deposits
- Deposits received today, deposits released on fulfillment (shown only when > 0)

### Alterations
- Alteration service income, included in recognized sales and separately disclosed (shown only when > 0)

### Inventory Receiving
- Units received, merchandise cost, and supplier inbound freight cost (shown only when > 0). Supplier freight is not added into item cost.

### Sales by Category
- Category name, net sales, COGS, margin %, units sold
- Margin color-coded: green (≥50%), amber (≥30%), red (<30%)

### QuickBooks Status
- Badge showing: Synced, Approved — Pending Sync, Pending Review, Posting Failed, or Not Staged

## Email Template

The report is rendered as a professional HTML email with:
- Dark gradient header with store name and date
- Two rows of color-coded KPI summary cards: three booked daily cards and three booked MTD/year-over-year cards
- Clean data tables with monospace amounts
- Exact current/prior MTD windows and a business-day weather section
- Category margin heat coloring
- QBO status badge
- Dark footer with generation timestamp

## Auto-Send Flow

After the register Z-close:
1. ROS saves the EOD snapshot
2. ROS ensures the pending QBO journal for the business date
3. **ROS checks daily report config** — if enabled:
   - Captures the business-date weather snapshot before report generation
   - Generates the report for the exact business date closed by the Z-report, even when staff closes it the following morning
   - Renders HTML email
   - Stores the report in `daily_financial_reports`
4. If auto-send is enabled and recipients are configured:
   - Emails to all configured recipients
   - Records only successfully delivered recipients and any errors
5. If a report was already sent for this date, the auto-send is skipped (no duplicates)

If delivery fails for one or more recipients, ROS leaves the report in an error
state instead of marking the business date sent. Successful recipients remain
recorded, and **Resend** retries only the recipients that did not receive that
failed delivery. Regenerating the same unsent business date refreshes the
existing archive row instead of failing the one-report-per-date constraint. A
failed automatic delivery also creates an actionable system alert directing
staff to the report history and retry action.

## Test Send

From the Settings panel, staff can send a **test report** at any time:
- Uses the most recent completed (non-test) report
- If no previous report exists, generates one for today
- Subject includes `[TEST]` prefix
- Stored with `is_test = true` so it doesn't block future auto-sends
- Optional email override to send to a different address

## Report History

The Settings panel shows all generated reports with:
- Date, recognized net sales, recognized transaction count
- Sent status (✓ sent, ✗ error, ⏳ not sent)
- Test badge for test sends
- **View** — opens an in-app HTML preview modal
- **Resend** — for a failed delivery, retries only recipients not already sent;
  otherwise re-emails the stored report to configured recipients

## API Endpoints

All endpoints require `settings.admin` permission.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/daily-reports/config` | Get report configuration |
| `PUT` | `/api/daily-reports/config` | Update report configuration |
| `POST` | `/api/daily-reports/generate` | Generate and store a report for a date |
| `POST` | `/api/daily-reports/send` | Generate, store, and email a report |
| `POST` | `/api/daily-reports/test-send` | Test send the most recent report |
| `GET` | `/api/daily-reports/history` | List stored reports (with filters) |
| `GET` | `/api/daily-reports/{id}` | Get full report detail + HTML |
| `POST` | `/api/daily-reports/{id}/resend` | Resend a stored report |

### Config Payload

```json
{
  "enabled": true,
  "recipient_emails": ["owner@store.com", "accountant@firm.com"],
  "subject_template": "Riverside OS — Daily Financial Report — {date}",
  "include_qbo_status": true,
  "include_inventory_activity": true,
  "auto_send_after_close": true
}
```

## Database

### Migration: `052_daily_financial_reports.sql`

- Adds `daily_report_config` JSONB column to `store_settings`
- Creates `daily_financial_reports` table with:
  - `report_date`, `generated_at`, `generated_by`
  - `report_payload` (full structured JSON), `html_content`
  - `sent_at`, `sent_to`, `send_error`
  - `is_test` flag
  - Unique index on `(report_date)` for non-test reports

## Dependencies

- **Email integration** must be configured in Settings → Email (SMTP credentials)
- **Visual Crossing weather** must be enabled with a valid API key in Settings → Integrations → Weather for actual weather data to appear; the report does not use simulated fallback weather
- **Store timezone** from `reporting.effective_store_timezone()` determines the business date
- **Store name** from `receipt_config.store_name` appears in the report header

## See Also

- [DAILY_SALES_REPORTS.md](DAILY_SALES_REPORTS.md) — Real-time register reports
- [staff/EOD-AND-OPEN-CLOSE.md](staff/EOD-AND-OPEN-CLOSE.md) — End-of-day procedures
- [staff/qbo-bridge.md](staff/qbo-bridge.md) — QuickBooks staging and sync
- [QBO_JOURNAL_TEST_MATRIX.md](QBO_JOURNAL_TEST_MATRIX.md) — Journal verification

**Last reviewed:** 2026-08-08
