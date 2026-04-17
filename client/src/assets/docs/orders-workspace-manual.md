---
id: orders-workspace
title: "Order Fulfillment Hub"
order: 1090
summary: "Manage regular Orders, Wedding, and Custom orders. Monitor deposits, track pickups, and manage the fulfillment pipeline."
source: client/src/components/orders/OrdersWorkspace.tsx
last_scanned: 2026-04-17
tags: orders, fulfillment, transactions, pickups, custom-mtm, weddings
---

# Transactions & Fulfillment (Back Office)

_Audience: Sales support, managers._

**Where in ROS:** Back Office → **Transactions**. Subsections: **Open Transactions**, **All Transactions**.

---

## How to use this area

**Open Transactions** is your **action queue** (unpaid, not picked up, alteration holds, etc.). **All Transactions** is your **history** search for receipts, disputes, and CRM follow-up.

### The Three Fulfillment Types

1.  **Special Order**: Standard floor items that were out of stock. Fixed catalog pricing.
2.  **Custom (MTM)**: Suits, shirts, or slacks where **price and cost vary with every order**. Ensure vendor costs are attached before final fulfillment.
3.  **Wedding Order**: Items linked to a specific wedding party for group event tracking.

## Open Transactions Queue

1. **Transactions** → **Open Transactions**.
2. Sort or filter by **date**, **customer**, or **status**.
3. Click a transaction to verify **lines**, **balance due**, and **customer** info.
4. **Take payment**: Use the tender UI to confirm $0 balance or record a partial payment.
5. **Pickup / Fulfill**: Complete **line checkoffs** to prevent partial fulfillment mistakes.
6. **Attach Wedding**: Use this tool to link a standalone or imported transaction to a **Wedding Party**. This synchronizes it with the party's Registry Dashboard.

## All Transactions (History)

1. **Transactions** → **All Transactions**.
2. Set your **date range** first to maintain performance.
3. Search by **receipt number**, **customer name**, or **SKU**.
4. Access **receipt copies**, the **audit log**, or **ZPL** label reprints.

## Returns, Refunds, and Exchanges

- Use the **return lines** or **exchange link** tools. Do not bypass refund queue rules.
- **Void Sale**: Used for unpaid mistake carts. This is separate from a **Refund** after payment has been taken.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Transaction not found** | Widen the date range; ensure you are in the correct store location. |
| **Cannot refund (403)** | Requires `transactions.refund_process` permission. |
| **Pickup blocked** | Usually means there is an unpaid line balance. Read the banner hint. |
| **Balance incorrect** | Refresh the transaction; if it persists, contact the Finance lead. |

**Last reviewed:** 2026-04-17
