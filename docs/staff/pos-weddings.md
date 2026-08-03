# POS Weddings

**Audience:** Consultants and floor staff handling wedding parties at the register.

**Where in ROS:** POS mode → left rail **Weddings** (heart icon).

**Related permissions:** **weddings.view** to read wedding data; **weddings.mutate** to change party/member state; **wedding_manager.open** to open the full Wedding Manager shell/tab.

---

## How to use this screen

POS **Weddings** keeps **party lookup**, **balances**, and **next steps** beside the cart so you do not jump to Back Office during a busy Saturday. It uses the same **native** wedding UI as the main module (no external iframe).

The Wedding Party Hub is a tracker over ROS records. Customer contact information comes from the linked Customer; purchased items and fulfillment come from Transaction/Fulfillment Order lines; payment labels come from applied payments, held deposits, and the current balance; and appointment counts come from the party's ROS appointments. An open party refreshes every minute, when ROS regains focus, and when Wedding or appointment updates arrive.

**Rush Tracking:** If any member has a **Rush Order** (priority "Need By" date), it will be flagged on the **POS Dashboard** and the **Morning Compass** queue. Use these shortcuts to prioritize fittings or pickups for that party.

## Common tasks

### Help a wedding member at the Register

1. POS → **Register**.
2. Attach the customer profile.
3. If they belong to a current wedding, use the compact party row to verify party, role, date, and status. Choose **Start Order** for the correct party or **Measure** to open the customer's measurements. When more than one active wedding is listed, Riverside does not select one automatically. After starting, **Wedding party for this sale** can switch the party only while the Cart is empty.
4. Choose **Yes — Build Wedding Order** for wedding merchandise. Choose **No — Regular Sale** only for an unrelated purchase; **Start Wedding Order** can reopen it.
5. The cart rail now shows the **Wedding Checklist**. Select this member's exact variation for each needed parent item:
   - **Take now** for in-store items the customer will leave with.
   - **Order** for exact items that need vendor ordering or later fulfillment.
   - **Measure** when measurements or the exact size/variation are not final.
   - On the final variation step, confirm the regular price, enter any approved **Line discount %**, and verify the final unit price. Discounts above the staff limit require Manager Access and are recorded in the authorization audit.
6. Add exceptions, searched/scanned items, or alterations as needed. Additional merchandise defaults to Wedding Order while this member is active.
7. If a held wedding deposit appears, confirm the named payer and explicitly apply the intended amount in **Pay**. The notice does not apply money by itself.
8. Confirm the salesperson and complete checkout normally. Nothing financial posts from the question or checklist; the successful checkout creates the member Transaction Record, Wedding Fulfillment Order, deposit redemption, tax, reporting, and receipt.

If an item is shown as a checklist-only note, it is not linked to a sellable ROS product yet. Open the full party before charging for it.

Changing or removing the Customer clears the Wedding question, member checklist, variation panel, and any unposted deposit application.

### Open the correct party

1. POS → **Weddings**.
2. Search **groom last name**, **bride**, **event date**, or **party ID** from paperwork.
3. Confirm **event date** and **city** aloud with customer before taking payment.

### Explain balance due

1. Open **party** or **member** financial view (per UI).
2. Point to **Balance Due**, **Applied Payments**, and **Held Deposit**; explain what is left versus what has actually been applied. A held deposit remains **Deposit** until Register applies it. **Paid** requires a linked Transaction with no balance due.
3. If **disbursement** (split payers) applies, follow **trained** checkout — do not split arbitrarily.

### Quick “is my tux ready?”

1. Find **member** row.
2. Read the ROS-derived **Ordered**, **In Stock**, and **Picked Up** status. These stages are read-only in Wedding Manager.
3. If status unclear, **Alterations** or **Orders** may have detail — get lead.

### Wedding orders in shared Orders screens

Wedding order work also appears in the shared **Orders** views.

- They should stay marked as **Wedding**, not a generic Order.
- The order detail should show the linked **party**, **member role**, **event date**, and parent Transaction Record context.
- Deposits, group pay, and pickup follow-up should stay tied to the linked wedding member record.
- A fully paid wedding order is not automatically ready for pickup. Staff still need to confirm measurements, receiving, and member readiness before handing anything over.
- In POS order review, treat a wedding-linked order as a member follow-up step, not a generic open order or the whole sale.
- Register uses the same Wedding Manager source. If a member still needs measurements, use **Measure** so the line stays **Needs measurements** until the exact variation is selected.

### Archive an inactive tracker

Use Manager **Archive Tracking** for a passed, cancelled, incomplete, legacy, duplicate, or test wedding tracker. Review and acknowledge the linked ROS snapshot when open work exists. Archiving removes the tracker from active Wedding boards but does not pay, cancel, fulfill, ship, refund, close appointments, or change alterations. Reopen it from **Closed / Archived** when needed.

## Helping a coworker

- **“Party not found.”** — Try **alternate spelling**; check **event year**; verify not **archived**.
- **“Balance zero but customer disagrees.”** — Open **Orders** linked to member; compare **receipt** numbers.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Wedding Manager tab missing | **wedding_manager.open** | Manager |
| Stale balance | **Refresh** / re-open party | Network |
| Cannot save edit | **weddings.mutate** | Manager |
| Wrong member paid | **Disbursement** reversal needs lead | [WEDDING_GROUP_PAY_AND_RETURNS.md](../WEDDING_GROUP_PAY_AND_RETURNS.md) |

## When to get a manager

- **Contract** or **package** changes mid-event.
- **Refund** spanning multiple payers.
- **Legal name** change on contract vs POS profile.

---

## See also

- [weddings-back-office.md](weddings-back-office.md)
- [../WEDDING_GROUP_PAY_AND_RETURNS.md](../WEDDING_GROUP_PAY_AND_RETURNS.md)

**Last reviewed:** 2026-08-03
