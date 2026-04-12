# Fulfillment Command Center — Throughput Guide

Riverside OS utilize a prioritized fulfillment queue to maximize staff throughput and ensure high-priority orders (Rush, Wedding-linked) are handled first.

## Urgency Scoring Logic

The fulfillment queue ([fulfillment_queue.rs](file:///server/src/logic/fulfillment_queue.rs)) categorizes open orders into four actionable buckets:

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

## API Integration

The `GET /api/orders/fulfillment-queue` endpoint returns a summary of these counts and a ranked list of orders. 
*   **Query Params**: `limit`, `offset`.
*   **Permissions**: `orders.view`.

## UI Components

### FulfillmentCommandCenter.tsx
A high-density dashboard used in the **Operations** workspace.
*   **Stat Cards**: Pulsing indicators for Rush and Due Soon items.
*   **Queue Table**: Summarized order rows with quick-jump links to the Back Office.

## Operational Best Practices
*   **Mid-Day**: Focused effort on **Rush** and **Due Soon** items.
*   **Intelligence Check**: Review the **Wedding Health Heatmap** in the Wedding Manager to identify "silent failures" (missing measurements) before they hit the fulfillment queue.
*   **Manager Review**: Check the **Blocked** filter weekly to prune dead orders.
