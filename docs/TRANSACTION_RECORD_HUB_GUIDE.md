# Transaction Record Hub Guide — Riverside OS

The **Transaction Record Hub** is the unified administrative view for financial sale records: historical sales, payments, receipts, refunds, returns, balances, and audit history. It may show linked fulfillment context, but the financial Transaction Record is not the same thing as a Fulfillment Order.

## Core Component

- **Location**: `client/src/components/orders/TransactionDetailDrawer.tsx`
- **Purpose**: Provides a full financial and items-level audit for any transaction ID (`transaction_id`) or visible transaction number (`TXN-...`).

## Boundary

- **Transaction Record**: financial sale record for payments, receipts, refunds, returns, balances, and audit.
- **Fulfillment Order**: Special, Custom, or Wedding fulfillment work.
- **Layaway**: separate workflow; do not describe it as an Order.

### Key Features

1. **Integrated Receipt Management**: 
   - Embeds `ReceiptSummaryModal` for instant reprinting (Thermal), Email, or SMS delivery.
   - Used to satisfy customer requests for records directly from the Relationship Hub.

2. **Financial Transparency**:
   - Explicitly breaks down Subtotal, Tax, Amount Paid, and Balance Due.
   - Joins with `payment_allocation` to show applied funds.

3. **Status Audit Log**:
   - Displays the sequence of events (Booked -> Fulfilled -> Returned etc.) directly from the `transaction_audit_events` table.

4. **Deep-Link Protocol**:
   - Supports global deep links via `?tab=home&subsection=[dashboard|reviews]&transaction_id=[UUID]`.
   - Notifications for Review Invites, Refunds, and Fulfillment events utilize this to open the hub instantly.

## Integration Locations

### 1. Customer Relationship Hub
- Located in the **Transactions** tab of the `CustomerRelationshipHubDrawer`.
- The **"Receipt"** button now triggers the Transaction Record Hub slideout instead of navigating to the POS reports.
- **Invariant**: Stay in the Hub. Administrative review of a customer's history should not break the staff member's CRM focus.

### 2. Reviews Operational Cockpit
- Located in `ReviewsOperationsSection.tsx`.
- The **"Record"** action allows staff to verify the details of a transaction before following up on a review invite or decision.
- Ensures review invites are anchored to the financial Transaction Record.

### 3. Notification Center
- Notifications that reference a specific sale (e.g., "Review Invite Recorded") now use the `transaction_id` to deep-link directly into the `TransactionDetailDrawer` within the relevant app section.

## Development Standards

- **Permissions**: Viewing details requires `orders.view`. Reprinting requires `register.reports` (inherited via the Receipt Modal).
- **Navigation**: Always prefer the slideout (Drawer) pattern over full-page redirects for transaction review to preserve the user's primary workspace state.
- **Deep-Link Usage**: When generating new app notifications for transactions, always include the `transaction_id` in the `link_data` payload.
