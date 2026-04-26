# Commission Reporting Ledger

Riverside OS commissions use an immutable reporting ledger for earned commission, fixed incentives, return adjustments, and manual adjustments.

## Goal

Replace mutable line-level payout behavior with a clear commission event ledger.

The reporting model should answer:

- What did each staff member earn for a selected period?
- Which sale, SPIFF, combo, return, exchange, or manual adjustment created each amount?
- Which staff rate was used at the time?
- Why did the amount change?

## Non-Goals

- No payroll provider integration.
- No pay-date automation.
- No category commission percentage overrides.
- No product or variant percentage override hierarchy.
- No customer-facing receipt changes for internal incentive lines.

## Event Types

Recommended `commission_events.event_type` values:

- `sale_commission`
- `spiff`
- `combo_incentive`
- `return_adjustment`
- `exchange_adjustment`
- `manual_adjustment`

## Event Snapshot Fields

Each event should store the values needed to explain the report without recalculating against today's settings:

- `id`
- `staff_id`
- `transaction_id`
- `transaction_line_id`
- `source_event_id`
- `event_type`
- `event_at`
- `reporting_date`
- `commissionable_amount`
- `base_rate_used`
- `base_commission_amount`
- `incentive_amount`
- `adjustment_amount`
- `total_commission_amount`
- `snapshot_json`
- `note`
- `created_by_staff_id`
- `created_at`

`snapshot_json` should include human-readable context such as product name, transaction short id, staff name, rate source, SPIFF label, combo label, return reason, and manual adjustment reason.

## Reporting Rules

- Default report window: prior calendar month.
- Supported windows: day, week, month, year, custom.
- All-staff summary groups by staff.
- Individual staff report lists event-level detail.
- Net commission is `SUM(total_commission_amount)` for the selected period.

## Staff Rate Rules

- Staff Profile remains the only base commission rate authority.
- `staff_commission_rate_history` remains the effective-dated source for rate lookup.
- A sale event snapshots the effective staff rate at recognition time.
- Changing a staff rate never rewrites existing commission events.

## SPIFF and Combo Rules

- SPIFFs and combo incentives add fixed-dollar amounts.
- They do not replace the staff base rate.
- Percentage overrides in `commission_rules.override_rate` should be ignored or migrated out.
- Existing fixed SPIFF rules can be migrated into event generation.

## Returns and Exchanges

Returns after a prior reporting month should create a negative event in the return month.

Example:

- April earned event: `+20.00`
- May return adjustment: `-20.00`

Exchanges should create:

- a negative return adjustment for the returned line;
- a new positive sale commission event for the replacement line when it becomes eligible.

## Manual Adjustments

Manual adjustments require:

- staff member;
- amount;
- reporting date;
- note;
- creator staff id;
- timestamp.

Manual adjustments should be append-only. Corrections should be new reversing events, not edits.

## Trace Behavior

Truth Trace should read the stored event snapshot.

It should show:

- staff member;
- transaction or adjustment source;
- reporting date;
- base rate used;
- commissionable amount;
- base commission;
- SPIFF/combo/manual/return adjustment;
- final event amount;
- note and audit metadata where applicable.

## Migration Outline

1. Add `commission_events`.
2. Backfill events from existing fulfilled `transaction_lines`.
3. Backfill fixed SPIFF/combo internal lines as incentive events.
4. Generate negative events for future returns/exchanges instead of mutating prior earned commission.
5. Add manual adjustment endpoint and UI.
6. Point commission reports and trace modal at `commission_events`.
7. Retire visible payout finalization and percentage override behavior.

## Compatibility Notes

The legacy line-level `calculated_commission` column remains for checkout compatibility and backfill support, but reporting and trace are backed by `commission_events`.
