---
id: qbo-mapping-matrix
title: "QBO Mapping Matrix (qbo)"
order: 1081
summary: "Guide to linking Riverside OS accounts (Revenue, Inventory, Tenders) to your QuickBooks Online Chart of Accounts."
source: client/src/components/qbo/QboMappingMatrix.tsx
last_scanned: 2026-05-23
tags: qbo, mapping, accounting, chart-of-accounts, coa, setup
---

# QBO Mapping Matrix

## Screenshots

![Reports catalog for accounting context](../images/help/reports/catalog.png)

![Insights dashboard for accounting review](../images/help/insights/metabase-main.png)

![Operational home for daily review](../images/help/operations-operational-home/main.png)

The Mapping Matrix is the configuration engine that tells Riverside OS where to "post" every dollar. Correct mappings are essential for automated reconciliation with QuickBooks Online.

## What this is

Use the **Mapping Matrix** to link Riverside categories and payment tenders to your QuickBooks Online Chart of Accounts.

## What this is

Use this matrix to map Riverside categories and tenders to the correct QuickBooks Online chart-of-accounts records. Required default accounts are configured in the **Required default mappings** table directly below the matrix.

## Mapping categories

The matrix is divided into three primary sections:

### 1. Revenue & COGS (by Category)
For every product category (e.g., Clothing, Accessories), you must map:
- **Revenue Account**: Usually an Income account.
- **COGS Account**: Usually an Expense account for Cost of Goods Sold.
- **Inventory Asset**: The asset account where inventory value is held.

### 2. Tenders (Payment Methods)
Map each payment method (Cash, Check, Card) to its respective clearing or asset account.
- **Standard Tenders**: Map to "Cash on Hand" or your primary bank account.
- **Merchant Tenders**: **IMPORTANT:** We recommend mapping these to a "Merchant Clearing" (Other Current Asset) account rather than your checking account.

### 3. Required Defaults
These are explicit accounts used by global financial logic:
- **Merchant Processing Fees**: Map this to your "Merchant Fees" or "Bank Charges" expense account.
- **Sales Tax**: Map to your "Sales Tax Payable" liability account.
- **Shipping Expense**: Map to your outbound shipping freight account.
- **Receiving clearing**: Map `INV_RECEIVING_CLEARING` before relying on receiving or freight journal rows. This is the receiving-clearing role used for same-day received merchandise and inbound freight distributions; inbound freight stays separate and is not added into item cost.
- **Gift Card Breakage Income**: Map expired purchased-card breakage separately from normal sales revenue.

## How to map an account

1. Navigate to **Back Office → Settings → QBO Bridge → Mappings**.
2. Locate the row you wish to update.
3. Select the matching account from the **QBO Account** dropdown.
4. Tapping "Save Matrix" persists category, tender, and liability mappings. Required default mappings save from their own row controls below the matrix.

## Tips

- **Balanced Journals**: If you leave a required account unmapped, the daily journal includes a warning in the staging queue and must be resolved before posting.
- **New Accounts**: If you create a new account in QuickBooks, you must click **"Refresh QBO accounts"** at the top of the matrix to see it in the list.
- **Clearing Account Reconcile**: Use the "Transfer" feature in QuickBooks to move funds from your "Merchant Clearing" account to your "Checking" account once the daily settlement hits your bank statement.

## What happens next

After you save the matrix, future journal proposals use the updated mappings the next time Riverside prepares QBO posting data.

## Connection health

Before relying on automated or manual sync, confirm the QBO connection is healthy:
- **Company Info** validates the live Intuit connection and displays the QBO company name.
- **Token Health** shows whether the access token is valid, refreshable, or expired, and the minutes remaining before expiry. The system auto-refreshes tokens in the background when within 10 minutes of expiry.
