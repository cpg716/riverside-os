---
id: settings-stripe-settings-panel
title: "Stripe & Merchant Hub (settings)"
order: 1102
summary: "High-level integration manual for card processing, fee reconciliation, and QBO clearing account workflows."
source: client/src/components/settings/StripeSettingsPanel.tsx
last_scanned: 2026-04-11
tags: settings-stripe-settings-panel, merchant-processing, reconciliation, stripe, qbo
---

# Stripe & Merchant Hub (settings)

<!-- help:component-source -->
_Linked component: `client/src/components/settings/StripeSettingsPanel.tsx`._
<!-- /help:component-source -->

The Stripe integration in Riverside OS is a high-level financial pipeline designed for accurate revenue recognition and seamless bank reconciliation.

## What this is

Staff and Managers use this screen to monitor the total volume of processed credit card transactions and verify that merchant fees are being correctly reconciled with QuickBooks Online.

## Key Features

### 1. The Merchant Hub
The **Activity Overview** provides a real-time summary of:
- **Gross Volume**: Total payments collected from customers.
- **Merchant Fees**: Exact processing fees charged by Stripe (reconciled via automated webhooks).
- **Net Amount**: The actual funds that will be deposited into your bank account.

### 2. QBO Clearing Account Pattern
To solve the issue of bundled bank deposits (where multiple days of sales are deposited at once), ROS uses a **Clearing Account pattern**:
- Every Stripe sale is recorded as a **Gross Debit** to your designated "Stripe Clearing" account.
- Fees are automatically posted as an **Expense** line.
- This leaves the **Net Balance** in the clearing account, making it easy to "transfer" the total to your checking account when the actual deposit hits your bank.

### 3. MOTO & Manual Entry
Staff can securely take payments over the phone or enter card details manually without a physical reader. These are flagged as **MOTO** (Mail Order/Telephone Order) for auditing and security compliance.

## How to use it

1. **Monitor Activity**: Check the dashboard daily to ensure Gross and Net totals match your daily sales reports.
2. **Verify Reconciliation**: If a transaction is missing fees, check the **Integration Health** section to ensure Stripe webhooks are firing correctly.
3. **QBO Mappings**: Ensure the "Merchant Processing Fees" expense account is correctly mapped in the **QBO Bridge** settings.

## Tips

- **Re-Syncing**: If you update fee mappings in QBO, use the "Refresh Matrix" button in the QBO Bridge to ensure updated journals use the correct accounts.
- **Fraud Monitoring**: Use the **Payment Ledger** (Insights) to view the card brand and last 4 digits for any suspicious phone orders.

## Technical Details

- **Webhook Reconciliation**: Fees are fetched asynchronously via Stripe's `BalanceTransaction` API. This may take a few seconds after the sale to appear in the dashboard.
- **Security**: Card data is never stored on ROS servers. All manual entries use Stripe's secure tokenization (vaulting).
