---
id: customers-workspace
title: "Customer CRM Hub"
order: 1005
summary: "Manage your client relationships, track lifetime sales, monitor wedding party membership, and handle duplicate accounts."
source: client/src/components/customers/CustomersWorkspace.tsx
last_scanned: 2026-04-11
tags: crm, customers, sales, duplicate-review
---

# Customer CRM Hub

The Customer CRM Hub is a high-density primary workstation for managing client relationships. It prioritizes financial transparency and operational speed, allowing for rapid lookup and management of large customer bases.

## High-Density Grid

The main display uses a high-density table grid designed for maximum information visibility:
- **Member Focus**: Primary names and [Customer Codes](file:///docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md) are prominently displayed.
- **Financial Pulse**: Real-time tracking of **Lifetime Sales** and current **Open Balance** (RMS Charge) is visible for every row.
- **Wedding Identity**: Displays linked Wedding Party names directly in the grid for quick retail context.
- **VIP & Activity**: Visual badges indicate loyalty standing and recent engagement.

## CRM Operations

### Searching & Filtering
- **Universal Search**: Use the top bar to search by name, phone, email, or customer code.
- **Quick-Filters**: Narrow down by "With Open Balance," "Wedding Party Members," or "Recent Sign-ups."

### Customer Management Hub
Click any row to open the **Customer Relationship Hub**. This slide-out panel provides a 360-degree view:
- **Timeline**: Chronological history of all orders, returns, and point adjustments.
- **Measurements**: Access specialized measurement vaults for custom work.
- **Messaging**: Local Inbox for Podium SMS/Email threads.
- **Shipments**: Track packages and generate new labels via Shippo.

### Duplicate Review
Located in the sidebar, the **Duplicate Review** queue highlights potential account collisions based on name/phone/email matches. Staff can merge accounts here to maintain a clean CRM.

## Tips

- **Load More**: The grid uses performance-optimized pagination. Click "Load More" at the bottom to continue browsing large lists.
- **Balance Alerts**: Customers with significant open balances will be highlighted in the grid to facilitate collections during checkout.

> [!IMPORTANT]
> Merging customers in the Duplicate Review queue is irreversible. Ensure you are merging the *correct* historical record into the primary account.

