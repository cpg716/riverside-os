---
id: qbo-workspace
title: "QBO Workspace"
order: 1082
summary: "Review QuickBooks Online staging, balanced proposals, drilldown evidence, and liability tender treatment."
source: client/src/components/qbo/QboWorkspace.tsx
last_scanned: 2026-05-23
tags: qbo, quickbooks, accounting, journal, staging, finance
status: approved
---

# QBO Workspace

## Screenshots

![Reports catalog for accounting context](../images/help/reports/catalog.png)

![Insights dashboard for accounting review](../images/help/insights/metabase-main.png)

![Operational home for daily review](../images/help/operations-operational-home/main.png)

## What this is

QBO Workspace is the review and staging area for QuickBooks Online journal proposals. It is designed for auditability before anything is synced to the accounting system.

## How to use it

1. Open the proposal for the accounting date being reviewed.
2. Confirm the proposal is balanced.
3. Review drilldown evidence for sales, shipping income, refunds, gift cards, store credit, and open deposits.
4. Sync only after the proposal and evidence match the expected activity.

## Review proposals

Review the proposal date, totals, journal lines, balance status, and drilldown evidence before syncing.

After a register is closed for the day, ROS stages the daily journal for that store-local business date. A background worker also auto-proposes the previous business date at 2 AM local time, so most days will already have a pending row when accounting opens. If the day is already staged but still pending, staging refreshes the same row with the latest facts. If the day was already approved or synced and later sales, returns, deposits, or payment-date corrections change the day, ROS creates a revision proposal for the same business date.

### Connection health

Before syncing, confirm the QBO connection is healthy:
- **Company Info** validates the live connection against Intuit and shows the QBO company name.
- **Token Health** shows whether the access token is valid, refreshable, or expired, and how many minutes remain before expiry. The system auto-refreshes tokens in the background when within 10 minutes of expiry.

Backdated corrections keep two dates clear:

- **Business date** controls booked-sales reporting and the QBO journal day.
- **Payment effective date** controls tender, deposit, and payment movement evidence.

Refund-day proposals should remain balanced and show refund or outflow tender evidence when a processed refund exists.

## Returns and refunds

Returned items should reduce effective quantity in QBO drilldown evidence. Revenue drilldown should reflect the quantity after returns, not the original sold quantity.

Processing a cash refund should leave negative payment or allocation evidence and close or update the refund queue.

## Store credit and open deposits

Store credit and open deposit redemptions are liability-release activity. They should not be treated as cash or card tender revenue.

Manual store-credit adjustments are audit-sensitive and should only post to QBO when the configured accounting path intentionally includes them.

## Shipping, alterations, and clearing accounts

Customer-charged shipping posts to the mapped Shipping income account on the same completed business date as the sale. Alteration service lines, refund queue clearing, forfeited deposit income, RMS clearing, and cash rounding each require their own mapped accounts before syncing days that contain that activity.

QBO posts use the staging row as the retry identity. Re-sending the same approved staging row uses the same request id so retry behavior stays recoverable.

### Approval audit trail

Every approved staging row records the **approver staff member** and the **approval timestamp** in the History detail. This creates an auditable chain: who reviewed the journal, when they approved it, and when it synced to QBO. Do not approve on behalf of another staff member.

## Gift card subtypes

Purchased, loyalty, donated, and promo gift cards have different accounting intent. Review the QBO evidence to confirm each subtype follows the expected liability, loyalty, donation, or promotional path.

Promo gift cards are operationally different from purchased gift cards and should remain visible in evidence.

## Counterpoint imports

Historical imported Counterpoint activity should remain auditable but should not contaminate current ROS QBO proposals.

## What to watch for

- Do not sync an unbalanced proposal.
- Confirm refund, shipping, clearing, and liability evidence before syncing days with returns, store credit, deposits, shipping charges, or gift card activity.
- If drilldown evidence does not match the visible transaction history, stop and ask for accounting review.

## Inline Mapping Resolution (v0.85.0+)

To accelerate troubleshooting, the QBO Workspace staging review panel displays **Inline Mapping Resolvers** directly underneath any missing mapping warnings:
- When a proposal fails validation because an account mapping is missing (e.g. `income_gift_card_breakage`, `liability_gift_card`, `COGS_FREIGHT`), a dropdown selector preloaded with the QBO Chart of Accounts appears directly on the warnings line.
- Select the appropriate QuickBooks account and click **Save Mapping** to commit the configuration immediately.
- Once saved, click **Stage journal** to regenerate the proposal using the newly established mapping.

## Related workflows

- [Reports](manual:reports)
- [Counterpoint Sync Settings](manual:settings-counterpoint-sync-settings-panel)

