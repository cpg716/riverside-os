# Commission Reporting and Incentives

**Status:** Canonical operator-facing commission and SPIFF guidance. For reporting basis rules, see [`REPORTING_BOOKED_AND_FULFILLED.md`](REPORTING_BOOKED_AND_FULFILLED.md); for the full reporting doc map, see [`REPORTING.md`](REPORTING.md).

Riverside OS commissions are being simplified into a reporting-first system for Riverside Men's Shop.

The intended store rule is:

- Each staff member's base commission rate is set on the Staff Profile.
- Staff rate changes are effective-dated; the new rate applies from that date forward.
- Category, product, and variant percentage overrides are retired from the staff workflow.
- SPIFFs and combo incentives remain as fixed-dollar add-ons.
- Commission reporting can be reviewed by day, week, month, year, or custom period.
- The normal payroll review is the prior calendar month, reviewed on the first payday of the new month.
- Returns and exchanges affect the period in which the return/exchange happens.
- Manual commission adjustments are allowed only with full note and audit tracking.

## Workspace

Open **Staff → Commissions**.

The workspace is divided into two operator-facing areas:

1. **Reports** — Read-only commission reporting for all staff or one selected staff member.
2. **SPIFFs & Combos** — Fixed-dollar incentive configuration.

The old category commission rate editor and percentage override rule UI are no longer part of the staff-facing workflow.

## Reporting Timing

Commissions follow the fulfillment / recognition clock:

- Takeaway and pickup lines count when fulfilled.
- Shipped lines count when the shipment recognition event occurs.
- Booked-but-unfulfilled lines are visible as pipeline only; they are not earned commission.

The report screen shows:

- **Booked not fulfilled** — pipeline commission from sold lines that have not reached fulfillment.
- **Earned in period** — commission earned in the selected recognition period.

## Staff Rate Changes

Staff base rates are managed on the Staff Profile.

When a rate changes, the start date matters:

- activity before the start date uses the prior effective rate;
- activity on or after the start date uses the new rate;
- visible payout finalization is retired in favor of immutable event reporting.

## SPIFFs

SPIFFs are fixed-dollar incentives added on top of the staff member's base-rate commission.

Example:

- Base-rate commission: `$12.00`
- SPIFF: `$10.00`
- Reported commission: `$22.00`

SPIFFs do not replace or override the staff rate.

## Combo Incentives

Combo incentives are fixed-dollar rewards for qualifying bundles.

Current behavior:

- Each requirement has a quantity threshold.
- The qualifying items must be attributed to the same salesperson.
- Rewards are internal commission/reporting lines and remain off customer-facing receipts.

## Returns and Exchanges

Returns and exchanges must affect the current reporting period, not rewrite a prior paid month.

Example:

- April sale earned `$20.00`.
- The item is returned in May.
- May reporting should include a `-$20.00` commission adjustment.

Returns create immutable negative commission adjustment events in the return period.

## Manual Adjustments

Manual add/subtract entries are required for store-approved commission corrections.

Each adjustment must capture:

- staff member;
- amount;
- reporting date;
- reason/note;
- created by;
- created at.

Manual adjustments are recorded as immutable commission events.

## Event Ledger

See [Commission Reporting Ledger Plan](./COMMISSION_REPORTING_LEDGER_PLAN.md).
