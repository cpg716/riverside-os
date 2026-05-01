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

The default view showing high-level metrics for the selected period.

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
  - Merchant fees (Stripe)

- **Additional Metrics**:
  - Appointments
  - Online transactions
  - New wedding parties
  - Special fulfillment lines

**Controls:**
- Date presets: Today, Yesterday, This week, This month, This year, Custom
- Custom date range with Apply button
- Print button (full page report)
- Export CSV button

### 2. Activity Tab

Detailed transaction listing grouped by date.

**View Modes:**
- **Fulfilled (Pickup)**: Shows pickup/fulfilled transactions only (no duplicates with sale)
- **Booked (Sale)**: Shows sale transactions only

**Transaction Details:**
Each transaction shows:
- Kind (Sale, Fulfilled, Pickup, Wedding Party, Appointment)
- **Labels**: "Transaction Booked (Sale)" (Sale Date) vs "Transaction Taken (Fulfilled)" (Pickup Date)
- Takeaway flag
- Fulfillment type (Pickup, Ship)
- Customer Name, Customer #, and **Wedding Party** (when applicable)
- Deposits Paid and Balance Due
- Time of transaction
- Payment method (including **Check #** for check transactions)
- Online channel indicator
- Expand to show full line items:
  - Item name, SKU, quantity
  - Regular price vs Sale price
  - Subtotal, Tax, Total

**Grouping:**
Transactions are grouped by date with:
- Date header
- Transaction count
- Running total per day

**Grand Total:**
Displayed at bottom with transaction count and totals.

**Controls:**
- View Mode toggle (Fulfilled/Booked)
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

### Fulfilled (Pickup/Shipped)
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
