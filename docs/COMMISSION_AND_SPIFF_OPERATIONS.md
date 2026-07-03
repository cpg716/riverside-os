# Commission Reporting and Incentives

Riverside OS commissions are being simplified into a reporting-first system for Riverside Men's Shop.

The intended store rule is:

- Each staff member's base commission rate is set on the Staff Profile.
- Staff rate changes are effective-dated; the new rate applies from that date forward.
- Category, product, and variant percentage overrides are retired from the staff workflow.
- SPIFFs and combo incentives remain as fixed-dollar add-ons.
- Employee-purchase transactions carry zero commission for all staff (base rate and incentives are suppressed to 0%).
- Commission reporting can be reviewed by day, week, month, year, or custom period.
- The normal payroll review is the prior calendar month, reviewed on the first payday of the new month.
- Returns and exchanges affect the period in which the return/exchange happens.
- Manual commission adjustments are allowed only with full note and audit tracking.
- Riverside OS does not finalize or pay commissions; it tracks and reports commission events for payroll review.

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

The commission report is earned-only for payroll review. It intentionally excludes booked-but-unfulfilled pipeline from the main report.

The report screen shows:

- **Rate** — the staff member's current base commission rate.
- **Rate since** — the effective start date for the current rate when known.
- **Sales** — count of earned sales in the selected recognition period.
- **By rate** — commission earned from the staff member's base rate.
- **SPIFF $** — fixed SPIFF and combo incentive dollars earned in the period.
- **Earned commission** — the final payroll-facing earned commission amount.
- **Total commissions paid for period** — the all-visible-row total used for payroll review.

## Staff Rate Changes

Staff base rates are managed on the Staff Profile.

When a rate changes, the start date matters:

- activity before the start date uses the prior effective rate;
- activity on or after the start date uses the new rate;
- Manager-approved attribution corrections update the affected sale commission/SPIFF event to the corrected staff member and leave an attribution audit row.

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
- Reward amounts and requirement quantities must be greater than zero.
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

Use a manual adjustment when the store needs an explicit add/subtract entry unrelated to correcting the salesperson on the original sale. If the cashier selected the wrong salesperson, Manager Access can correct whole-sale or line-level attribution after recognition; Riverside OS updates the affected commission event snapshot and keeps the attribution audit row for review.

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
