# Daily Sales Reports (Register Reports)

## Overview

The Daily Sales Reports in Riverside OS provide store managers and cashiers with real-time sales analytics, transaction details, and register session tracking. The reports are accessible via the Back Office Operations tab or POS Register REPORTS button.

## Access

- **Back Office**: Navigate to Operations → Daily Sales
- **POS**: Click REPORTS in the register sidebar
- **Back Office Reports library**: search **Register Day Summary**, **Closed Register Drawers**, **cash**, **drawer**, **pickup**, or **daily sales** from Back Office → Reports

Required permission: `register.reports`

## Tab Structure

### 1. Dashboard Tab

The dashboard opens on the existing **Booked** basis for the selected period. Use the **Booked** and **Completed** basis controls to switch between what was rung and what is financially recognized.

**Metrics Displayed:**
- **Fulfilled (Pickup/Shipped)** section:
  - Transactions count
  - Revenue (subtotal without tax)
  - Tax collected
  - Net (after fees)

- **Booked (Sale)** section:
  - Sales # (number of transactions)
  - Sales $ (total sales amount)
  - Tax collected
  - Merchant fees (Helcim)

- **Additional Metrics**:
  - Appointments
  - Online transactions
  - New wedding parties
  - Special fulfillment lines

**Controls:**
- Date presets: Today, Yesterday, This week, This month, This year, Custom
- Custom date range with Apply button
- Print button (full page report for the currently selected basis)
- Export CSV button (includes grand total row with summed Transaction Total, Sales Total, Tax, and Net Total)
- Pickups Today section after the transaction list, showing customer info, Transaction Record, and picked-up items without treating pickup activity as a new sale card
- Historical Counterpoint import echo transactions are suppressed from Daily and Z reporting when a native ROS transaction exists for the same customer, store day, and item variation. This keeps old parallel-run imports from double-counting sales or pickups without deleting the source audit records.

**CSV Export Features:**
- **Grand Total Row**: Added at end of CSV with TOTAL label and summed values for Transaction Total, Sales Total, Tax, and Net Total
- **Tauri Native Dialog**: Desktop app uses native file save dialog via `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs`
- **Browser Fallback**: Graceful fallback to browser download method if Tauri environment is not available or save fails

### 2. Activity Tab

Detailed transaction listing grouped by date.

**View Modes:**
- **Activity List**: Transaction cards with payment method, timestamp, customer name, transaction ID, lane, and item details
- **Table View**: Traditional table format for quick scanning

**Z-Report Print Layout (Updated):**
- **Activity Cards**: Card-based layout showing payment method pill, timestamp, customer name, transaction ID chip, and lane chip
- **Business-only close packet**: The Z-Report no longer appends non-sale inventory activity; it focuses on tenders, cash reconciliation, sales/orders/refunds/exchanges, pickups, and vendor invoice counts.
- **Tender completeness**: The tender table always lists the supported tender methods, even when they have 0 transactions and $0.00 for the day.
- **Credit Card Total**: CC totals combine every real card subtype—CC/Card Reader, Card Manual, Card Not Present, saved card, and card refund/credit activity—while excluding non-card tenders such as Staff Account and exchange credit.
- **Card entry labels**: Hosted HelcimPay.js activity is labeled **Card Not Present**, including historical approvals whose audit reference carries the Helcim transaction suffix. **Card Manual** is reserved for externally recorded/manual card activity.
- **Register breakdown**: Each register lane shows Cash Total and CC Total only, with Card Manual and Card Not Present included in the CC lane total.
- **Quick Look page**: The second page presents the day’s quick-look business boxes before the transaction and pickup detail sections.
- **Item Display**: Enhanced item rows with bold product names, muted SKU/fulfillment details, final line price, regular price, and discount percent applied
- **Money Section**: Reorganized transaction totals with clear labels for Transaction Amount, Sale Total, Paid, and Balance Due
- **Visual Improvements**: New CSS classes for activity cards, pills, chips, section labels, and improved spacing/borders
- **Branding**: Changed header from "RIVERSIDE OS" to "RIVERSIDE MEN'S SHOP"
- **Tauri Integration**: Desktop app saves HTML file via native dialog and opens in default browser instead of direct print
- **Error Handling**: Added print failure error handling with user-friendly alerts
- **Generated Timestamp**: Added generated timestamp to report header and footer

**Daily Sales Report Print (Updated):**
- **Grand Total**: Added grand total calculation displayed at end of report
- **Balanced Quick Look**: The summary prints 15 boxes in 5-column rows, including New Appts, New Layaways, Picked Up $, and Discounts.
- **Dollar Counts**: Dollar summary boxes that represent grouped activity show amount plus count, such as `$500.00 (2)`.
- **Line Discount Detail**: Each printed transaction line includes regular price, final sale price, and discount percent applied
- **Document Title**: Added document title for browser tab identification
- **Generated Timestamp**: Added generated timestamp to report header and footer
- **Tauri Integration**: Desktop app saves HTML file via native dialog with save-and-open workflow
- **Section Rename**: Changed "Activity Detail" to "Transaction List" for clarity
- **Pickups Today**: Adds a compact pickup list after the Transaction List for customer, Transaction Record, and picked-up item review
- **Branding**: Changed header and footer from "RIVERSIDE OS" to "Riverside Men's Shop"

**Transaction Details:**
Each transaction shows:
- Kind (Sale, Fulfilled, Pickup, Wedding Party, Appointment)
- **Labels**: "Order Booked (Sale)" (Sale Date) vs "Order Pickup" (Pickup Date)
- Takeaway flag
- Fulfillment type (Pickup, Ship)
- Customer Name and Customer #, which open CustomerHub when a customer is linked, plus **Wedding Party** when applicable
- Deposits Paid and Balance Due
- Time of transaction
- Payment method (including **Check #** for check transactions)
- Online channel indicator
- Expand to show full line items:
  - Item name, SKU, quantity
  - Regular price vs Sale price
  - Discount percent applied
  - Subtotal, Tax, Total

**Grouping:**
Transactions are grouped by date with:
- Date header
- Transaction count
- Running total per day

**Grand Total:**
Displayed at bottom with transaction count and totals.

**Controls:**
- View Mode toggle (Completed/Booked)
- Date presets
- Print button
- Export CSV button

### 3. Z-Reports Tab

Register session closure history.

**Session Details:**
- Lane number
- Cashier name
- Open/Close times
- Total sales
- Expected cash
- Daily Cash Deposit date and amount

**Controls:**
- Period presets: Recent, Today, Yesterday, This week, This month, Custom
- Custom date range

## Date Presets

| Preset | Description |
|-------|-------------|
| Today | Current calendar day |
| Yesterday | Previous day |
| This week | Monday-Sunday |
| This month | Current month |
| This year | Current year |
| Custom | User-selected range |

## Reporting Basis

The Back Office Reports library uses the same staff-facing **Booked (sale date)** and **Completed (recognition)** wording for curated report tiles that support basis selection.

### Booked (Sale Date)
- Uses the date when the sale was processed
- Includes deposits on open transactions
- Matches register-day selling activity

### Completed (Pickup/Shipped)
- Uses recognition clock: pickup/takeaway by fulfillment time, ship when label purchased or in transit/delivered
- Matches tax and commission recognition
- Use for financial reporting (revenue recognition)

## Export Format

CSV export includes columns:
- Date, Time, Kind, Transaction ID
- Customer Name, Customer #
- Item Name, SKU, Quantity
- Regular Price, Sale Price
- Takeaway (Yes/No)
- Fulfillment Type
- Deposit Paid, Balance Due
- Subtotal, Tax, Total

## Print Layout

Professional full-page report includes:
- Header with store name, date range, report basis
- Summary statistics
- Grouped transaction listings
- Daily totals
- Grand totals

## API Endpoints

- `GET /api/insights/register-day-activity` - Daily sales data
- `GET /api/insights/register-sessions` - Z-Report sessions

### Parameters
| Parameter | Values | Description |
|-----------|--------|-------------|
| preset | today, yesterday, this_week, this_month, this_year, custom | Date range |
| basis | booked, fulfilled | Reporting basis |
| from | YYYY-MM-DD | Custom start date |
| to | YYYY-MM-DD | Custom end date |
| register_session_id | UUID | Scope to specific lane |

## Permissions

- `register.reports` - Required for store-wide view
- Open register session - Scopes to that lane

## Related: Daily Financial Report

For an automated **emailed** financial summary after register Z-close (covering net sales, tenders, tax, returns, deposits, gift cards, alterations, inventory receiving, category margins, and QBO status), see [DAILY_FINANCIAL_REPORT.md](DAILY_FINANCIAL_REPORT.md). That system is configured in **Settings → Daily Financial Report** and operates independently from the real-time register reports described here.
