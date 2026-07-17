# Fulfillment Command Center — Throughput Guide

Riverside OS utilize a prioritized fulfillment queue to maximize staff throughput and ensure high-priority orders (Rush, Wedding-linked) are handled first.

## Urgency Scoring Logic

The fulfillment queue ([fulfillment_queue.rs](../server/src/logic/fulfillment_queue.rs)) categorizes open orders into four actionable buckets:

### 1. Ready (Priority 1)
*   **Definition**: Orders where all "Fulfillment Required" items (Special Orders, Wedding Items) are marked as fulfilled, but the order remains open.
*   **Action**: These are waiting for customer pickup or final checkout.

### 2. Rush (Priority 2)
*   **Definition**: Orders with the `is_rush` flag set (e.g., custom rush work, last-minute alterations).
*   **Action**: High-intensity fulfillment required immediately.

### 3. Due Soon (Priority 3)
*   **Definition**: Orders with a `need_by_date` within the next **4 days**.
*   **Action**: Standard fulfillment pipeline.

### 4. Blocked (Priority 4)
*   **Definition**: Orders that have been open for over **14 days** with 0% fulfillment progress.
*   **Action**: Manager review required to unblock (verify stock, contact customer).

## ORDER Pick up Guards

### Inventory Availability Check
- **Purpose**: Warn and audit when pickup causes negative stock, without blocking the sale or customer release
- **Check**: Captures `stock_on_hand < quantity` for unfulfilled lines before pickup
- **Warning**: Register completes the pickup and records a negative-stock alert with need/have counts
- **Override**: Not required for stock shortage. Balance Due and readiness status remain hard guards.
- **Applies To**: All fulfillment types (special_order, custom, wedding_order, layaway) and all unfulfilled transactions

### Received Status Check
- **Purpose**: Ensure items physically arrived before marking ready for pickup
- **Check**: Verifies `received_at` is not NULL (item went through ordered → received lifecycle via vendor invoice)
- **Error Message**: "Cannot mark ready for pickup: item must be received first (ordered and received via vendor invoice)"
- **Override**: Staff with `manager.approval` and `orders.lifecycle_manage` can bypass with `override_checks`, selected staff approver + Access PIN, and a clear reason
- **Allows**: Negative inventory for exceptional cases (receiving later brings stock positive)

### Payment Screen Recognition
- **Purpose**: Ensure payment screen recognizes previous deposits for pickup transactions
- **Fix**: Shows order payment line even when balance due is 0 if there were previous deposits
- **Applies To**: All unfulfilled transactions regardless of fulfillment type or balance due status

### Manager Override Mechanism
- **Required**: Manager PIN and clear reason (minimum 12 characters)
- **Scope**: Bypasses readiness/received status checks and alteration pending checks
- **Use Case**: Exceptional cases where pickup must proceed despite un-received or otherwise unready items
- **Audit**: Override reason is logged for accountability

## API Integration

The `GET /api/transactions/fulfillment-queue` endpoint returns a summary of these counts and a ranked list of transactions.
*   **Query Params**: `limit`, `offset`.
*   **Permissions**: `orders.view`.

### Pickup API
- **Endpoint**: `POST /api/transactions/{transaction_id}/pickup`
- **Request Body**: `PickupTransactionRequest` with optional `override_readiness`, `override_reason`, `delivered_item_ids`
- **Checks Performed**: Balance due and readiness status. Inventory shortages are warnings/alerts, not blockers.
- **Permissions**: Requires an open Register session token

### Order Lifecycle API
- **Endpoint**: `PATCH /api/order-lifecycle/{transaction_line_id}/transition`
- **Request Body**: `TransitionRequest` with `next_status`, `reason`, `manager_pin`, `override_checks`
- **Checks Performed**: Alteration pending status, received status (when transitioning to ready_for_pickup)
- **Permissions**: `orders.lifecycle_manage`

## UI Components

### FulfillmentCommandCenter.tsx
A high-density dashboard used in the **Operations** workspace.
*   **Stat Cards**: Pulsing indicators for Rush and Due Soon items.
*   **Queue Table**: Summarized order rows with quick-jump links to the Back Office.

### RosieSettingsPanel.tsx
ROSIE configuration panel including:
*   **RosieTokenMonitor**: Displays daily token use, monthly usage, and estimated monthly cost
*   **Access**: Requires `help.manage` permission for token metrics view

## Operational Best Practices
*   **Mid-Day**: Focused effort on **Rush** and **Due Soon** items.
*   **Intelligence Check**: Review the **Wedding Health Heatmap** in the Wedding Manager to identify "silent failures" (missing measurements) before they hit the fulfillment queue.
*   **Manager Review**: Check the **Blocked** filter weekly to prune dead orders.
*   **Pickup Verification**: Always verify inventory availability before pickup. Use manager override only for exceptional cases with clear documentation.
*   **Layaway Handling**: All pickup checks apply to layaway transactions - ensure stock is available before releasing layaway items.
*   **Token Cost Monitoring**: Review ROSIE token telemetry monthly to evaluate local vs cloud API costs before scaling decisions.
