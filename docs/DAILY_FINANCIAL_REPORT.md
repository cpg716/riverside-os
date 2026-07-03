# Daily Financial Report

## Overview

The Daily Financial Report is an automated system that generates, stores, and emails a comprehensive financial summary at the end of each business day. It covers sales, tenders, tax, returns, deposits, gift cards, alterations, inventory receiving, supplier inbound freight, category margins, and QBO journal status.

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
- **Net Sales** — gross sales minus discounts
- **Transaction Count** — unique fulfilled transactions
- **Average Transaction** — net sales ÷ transaction count

### Sales Summary
- Gross sales, discounts, net sales, items sold. Discounts include POS price
  overrides, customer profile discounts, employee prices, and explicit discount
  amounts while keeping net sales on the final line price.

### Tax Collected
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
- Alteration service income (shown only when > 0)

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
- Color-coded KPI summary cards (green/blue/purple)
- Clean data tables with monospace amounts
- Category margin heat coloring
- QBO status badge
- Dark footer with generation timestamp

## Auto-Send Flow

After the register Z-close:
1. ROS saves the EOD snapshot
2. ROS ensures the pending QBO journal for the business date
3. **ROS checks daily report config** — if enabled + auto-send + recipients configured:
   - Generates the report for today's business date
   - Renders HTML email
   - Stores the report in `daily_financial_reports`
   - Emails to all configured recipients
   - Records sent status and any errors
4. If a report was already sent for this date, the auto-send is skipped (no duplicates)

## Test Send

From the Settings panel, staff can send a **test report** at any time:
- Uses the most recent completed (non-test) report
- If no previous report exists, generates one for today
- Subject includes `[TEST]` prefix
- Stored with `is_test = true` so it doesn't block future auto-sends
- Optional email override to send to a different address

## Report History

The Settings panel shows all generated reports with:
- Date, net sales, transaction count
- Sent status (✓ sent, ✗ error, ⏳ not sent)
- Test badge for test sends
- **View** — opens an in-app HTML preview modal
- **Resend** — re-emails the stored report to configured recipients

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
- **Store timezone** from `reporting.effective_store_timezone()` determines the business date
- **Store name** from `receipt_config.store_name` appears in the report header

## See Also

- [DAILY_SALES_REPORTS.md](DAILY_SALES_REPORTS.md) — Real-time register reports
- [staff/EOD-AND-OPEN-CLOSE.md](staff/EOD-AND-OPEN-CLOSE.md) — End-of-day procedures
- [staff/qbo-bridge.md](staff/qbo-bridge.md) — QuickBooks staging and sync
- [QBO_JOURNAL_TEST_MATRIX.md](QBO_JOURNAL_TEST_MATRIX.md) — Journal verification

**Last reviewed:** 2026-05-27
