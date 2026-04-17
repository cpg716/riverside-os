# POS Wedding Registry

**Audience:** Consultants and sales support staff managing wedding parties at the register.

**Where in ROS:** POS mode → left rail **Weddings** (heart icon).

**Related permissions:** **weddings.view** to read; **weddings.mutate** to update registry details.

---

## Registry Dashboard Overview

The **Wedding Registry** is the central hub for managing upcoming wedding parties directly from the register. Unlike standard lookups, the Registry Dashboard is proactive—it automatically displays upcoming events and highlights parties that need attention.

### Management Metrics

- **Upcoming:** Total events scheduled for the next 30 days.
- **Needs Attention:** Count of parties with overdue measurements or missing selections.
- **Order Progress:** Visual status of orders (Pending vs. Ready).
- **Total Registry:** The total number of active wedding parties managed by the store.

---

## Common Tasks

### Finding a Wedding Party

1. Click **Weddings** on the POS sidebar.
2. The dashboard automatically loads upcoming parties.
3. To find a specific party, use the **Search Registry** bar to search by **Groom/Partner Last Name**, **Event Date**, or **Party ID**.

### Viewing Registry Details

Click on any party card to open the **Registry Details** slideout. Here you can see:
- **Party Summary:** Event date, location, and primary contact.
- **Member Status:** Real-time visibility into who is "Measured", who has "Paid", and whose order is "Ready".
- **Product Details:** Items assigned to each member and the **Default Party Style**.

### Updating Member Information

1. Open the **Registry Details** for the party.
2. Select a member from the list.
3. Update their measurement status or order notes.
4. Changes are synced instantly with the back-office Wedding Manager.

### Group Pay (Split Deposit)

Use this when one person (e.g., the Groom or sponsor) is paying for deposits or balances for multiple party members at once.

1. Find the party in the **Wedding Registry** tab and select it.
2. Tap the **Enter Group Pay** button in the party header.
3. In the selection slideout, check the boxes for each member being paid for today.
4. Tap **Add Members to Cart**.
5. Each member's balance is added to your current Register cart as a disbursement.
6. Proceed to Checkout and tender the total amount.

---

## Registry UI Legend

| Indicator | Meaning |
| :--- | :--- |
| **Needs Attention** | Overdue measurement or coordination issue. |
| **Style Set** | All items for this member have been selected. |
| **Order Ready** | Logistical fulfillment is complete; items are in-store. |
| **Measured** | Profile measurements are current. |

---

## Supporting Your Team

- **"Party not appearing?"** Ensure you are searching the correct **Event Year**. Check "All Parties" if the event is outside the 30-day upcoming window.
- **"Balance mismatch?"** If a member's balance looks wrong, use the **Open in Register** shortcut to view their detailed transaction history and payment allocations.

## When to Escalate to a Manager

- Adjusting contract packages or base pricing.
- Processing complex refunds spanning multiple group members.
- Modifying legal contract details.

---

## See Also

- [Wedding Group Payments (Abstract)](abstracts/wedding-group-pay.md)
- [Back-Office Wedding Manager Guide](weddings-back-office.md)
- [Registry Split Deposits and Returns](../../docs/WEDDING_GROUP_PAY_AND_RETURNS.md)

**Last updated:** 2026-04-17 (v0.2.0 Registry Overhaul)
