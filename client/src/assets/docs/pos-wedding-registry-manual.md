---
id: pos-wedding-registry
title: "Wedding Registry Dashboard"
order: 1042
summary: "Proactive management of wedding parties, member status tracking, and group payments."
source: client/src/components/pos/PosWeddingWorkspace.tsx
last_scanned: 2026-04-17
tags: weddings, registry, dashboard, group-pay, members, status
---

# POS Wedding Registry (Quick Reference)

_Audience: Consultants and sales support staff handling wedding parties at the register._

**Where in ROS:** POS mode → left rail **Weddings** (heart icon).

---

## The Registry Dashboard

The POS Wedding section is a proactive **Wedding Registry Dashboard**. It automatically surfaces upcoming events and flags members that need attention (missing measurements, overdue balances, etc.).

### Proactive Management
- **Immediate Loading:** No search required for today's active parties.
- **Priority Metrics:** Real-time counts for "Needs Attention" and "Upcoming Events".
- **Member Indicators:** Visual status icons for Measured, Paid, and Order Ready.

## Common Operations

### Registry Lookup
1. Open **Weddings** on the POS rail.
2. Use the **Registry Search** bar for specific names or event dates.
3. Confirm event details with the customer before proceeding to the register.

### Explaining Balances
1. Open the member in the **Registry Details** slideout.
2. Review the **Balance Due** and recent payment history.
3. Use **Open in Register** to resolve balances or take new deposits.

### Measuring & Pickup
1. Find the member in the party list.
2. Check the **Order Progress** status.
3. Update notes or measurement status directly in the Registry Details.

### Group Pay (Split Deposit)
1. Tap **Enter Group Pay** on the Registry Dashboard.
2. Select members being paid for.
3. Tap **Add Members to Cart** to move them into the Register.

---

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Search yields no results** | Check alternate spellings or the event year filter. |
| **Status is stale** | Re-open the Registry Details to trigger a fresh sync. |
| **Cannot edit details** | Requires **weddings.mutate** permissions. |

---

## See Also
- [Order Fulfillment Hub](orders-workspace-manual.md)
- [Back-Office Wedding Manager Guide](weddings-back-office-manual.md)

**Last reviewed:** 2026-04-17
