---
id: qbo-mapping-matrix
title: "QBO Mapping Matrix (qbo)"
order: 1081
summary: "Guide to linking Riverside OS accounts (Revenue, Inventory, Tenders) to your QuickBooks Online Chart of Accounts."
source: client/src/components/qbo/QboMappingMatrix.tsx
last_scanned: 2026-04-11
tags: qbo, mapping, accounting, chart-of-accounts, coa, setup
---

# QBO Mapping Matrix

The Mapping Matrix is the configuration engine that tells Riverside OS where to "post" every dollar. Correct mappings are essential for automated reconciliation with QuickBooks Online.

![QBO Mapping Matrix](../images/help/qbo-mapping-matrix/main.png)

## What this is

Use the **Mapping Matrix** to link Riverside categories, payment tenders, and fallback accounts to your QuickBooks Online Chart of Accounts. 

## What this is

Use this matrix to map Riverside categories, tenders, and fallback accounts to the correct QuickBooks Online chart-of-accounts records.

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
- **Stripe/Merchant Tenders**: **IMPORTANT:** We recommend mapping these to a "Stripe Clearing" (Other Current Asset) account rather than your checking account.

### 3. Global Fallbacks
These are safety accounts used when a specific mapping is missing or for global logic:
- **Merchant Processing Fees**: Map this to your "Merchant Fees" or "Bank Charges" expense account.
- **Sales Tax**: Map to your "Sales Tax Payable" liability account.
- **Shipping Expense**: Map to your outbound shipping freight account.

## How to map an account

1. Navigate to **Back Office → Settings → QBO Bridge → Mappings**.
2. Locate the row you wish to update.
3. Select the matching account from the **QBO Account** dropdown.
4. Tapping "Save Matrix" will persist these mappings server-side for all future journal proposals.

## Tips

- **Balanced Journals**: If you leave a required account unmapped, the daily journal will use a "MISC FALLBACK" account and include a warning in the staging queue.
- **New Accounts**: If you create a new account in QuickBooks, you must click **"Refresh QBO accounts"** at the top of the matrix to see it in the list.
- **Clearing Account Reconcile**: Use the "Transfer" feature in QuickBooks to move funds from your "Stripe Clearing" account to your "Checking" account once the daily settlement hits your bank statement.

## What happens next

After you save the matrix, future journal proposals use the updated mappings the next time Riverside prepares QBO posting data.
