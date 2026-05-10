---
id: qbo-workspace
title: "QBO Workspace"
order: 1082
summary: "Review QuickBooks Online staging, balanced proposals, drilldown evidence, and liability tender treatment."
source: client/src/components/qbo/QboWorkspace.tsx
last_scanned: 2026-05-10
tags: qbo, quickbooks, accounting, journal, staging, finance
status: approved
---

# QBO Workspace

## What this is

QBO Workspace is the review and staging area for QuickBooks Online journal proposals. It is designed for auditability before anything is synced to the accounting system.

## How to use it

1. Open the proposal for the accounting date being reviewed.
2. Confirm the proposal is balanced.
3. Review drilldown evidence for sales, refunds, gift cards, store credit, and open deposits.
4. Sync only after the proposal and evidence match the expected activity.

## Review proposals

Review the proposal date, totals, journal lines, balance status, and drilldown evidence before syncing.

Refund-day proposals should remain balanced and show refund or outflow tender evidence when a processed refund exists.

## Returns and refunds

Returned items should reduce effective quantity in QBO drilldown evidence. Revenue drilldown should reflect the quantity after returns, not the original sold quantity.

Processing a cash refund should leave negative payment or allocation evidence and close or update the refund queue.

## Store credit and open deposits

Store credit and open deposit redemptions are liability-release activity. They should not be treated as cash or card tender revenue.

Manual store-credit adjustments are audit-sensitive and should only post to QBO when the configured accounting path intentionally includes them.

## Gift card subtypes

Purchased, loyalty, donated, and promo gift cards have different accounting intent. Review the QBO evidence to confirm each subtype follows the expected liability, loyalty, donation, or promotional path.

Promo gift cards are operationally different from purchased gift cards and should remain visible in evidence.

## Counterpoint imports

Historical imported Counterpoint activity should remain auditable but should not contaminate current ROS QBO proposals.

## What to watch for

- Do not sync an unbalanced proposal.
- Confirm refund and liability evidence before syncing days with returns, store credit, deposits, or gift card activity.
- If drilldown evidence does not match the visible transaction history, stop and ask for accounting review.

## Related workflows

- [Reports](manual:reports)
- [Counterpoint Sync Settings](manual:settings-counterpoint-sync-settings-panel)
