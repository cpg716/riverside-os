# Working Offline & Synchronization

## Role: All Staff
### Purpose: Ensuring business continuity during ISP outages or local network failures.

Riverside OS is designed to handle temporary network instability by caching critical POS actions and synchronizing them once the connection to the server is restored.

---

## Offline Capabilities (POS)

When the system detects it is "Offline", the following behavior applies:
- **Tally & Cart**: You can still add items and calculate totals.
- **Queueing**: Transactions are stored in a local "Offline Queue".
- **Visual Indicator**: A red status bar or "Syncing..." pulse will appear in the navigation bar.

> [!CAUTION]
> **Payments**: Integrated card readers (Stripe) require an active internet connection. If the network is down, manual credit card processing (on a standalone terminal) or Cash/Check must be used.

---

## What Does NOT Work Offline

- **Live Inventory**: Stock-on-hand counts may be stale.
- **Back Office**: Most administrative tasks (Settings, Staff, Reports) require a live API connection.
- **Wedding Search**: Real-time registry lookups are disabled; use cached party data if available.

---

## Restoring Connection

1. **Auto-Sync**: As soon as the network returns, the **Offline Queue** will automatically attempt to push transactions to the server.
2. **Success/Failure**: Review the **Sync Center** (accessible via the notification bell) to confirm all pending items are "Green".
3. **Drafts**: If a sync fails, the item remains as a "Draft". Do not re-process the sale until a manager reviews the Draft count.

---

## Common Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **"Sync Pending" for 10+ mins** | Check the store Wi-Fi or restart the Tailscale connection if applicable. |
| **Duplicate Charge Fear** | Compare the POS Order ID against the manual payment receipt before finalizing a sync. |
| **"Online Only" Error** | This indicates the action requires a live database lock. Stop and wait for connectivity. |

---

## Helping Customers

- **Transparency**: Notify customers that the system is in "Manual Backup Mode" and email receipts may be delayed.
- **Manual Log**: In severe outages, maintain a paper log of Customer Name, Phone, and Total Amount for manual entry once the system is online.

> [!IMPORTANT]
> Never "Clear Cache" or "Reset Site Data" while the system is offline, as this will permanently delete all un-synced transactions.
