# POS Weddings

**Audience:** Consultants and floor staff handling wedding parties at the register.

**Where in ROS:** POS mode → left rail **Weddings** (heart icon).

**Related permissions:** **weddings.view** to read wedding data; **weddings.mutate** to change party/member state; **wedding_manager.open** to open the full Wedding Manager shell/tab.

---

## How to use this screen

POS **Weddings** keeps **party lookup**, **balances**, and **next steps** beside the cart so you do not jump to Back Office during a busy Saturday. It uses the same **native** wedding UI as the main module (no external iframe).

**Rush Tracking:** If any member has a **Rush Order** (priority "Need By" date), it will be flagged on the **POS Dashboard** and the **Morning Compass** queue. Use these shortcuts to prioritize fittings or pickups for that party.

## Common tasks

### Help a wedding member at the Register

1. POS → **Register**.
2. Attach the customer profile.
3. If they belong to a current wedding, the customer strip shows the party and the cart rail shows **Wedding Checklist**.
4. Confirm the party name and event date.
5. Add each needed linked item:
   - **Take now** for in-store items the customer will leave with.
   - **Order** for exact items that need vendor ordering or later fulfillment.
   - **Measure** when measurements or the exact size/variation are not final.
6. Complete checkout normally.

If an item is shown as a checklist-only note, it is not linked to a sellable ROS product yet. Open the full party before charging for it.

### Open the correct party

1. POS → **Weddings**.
2. Search **groom last name**, **bride**, **event date**, or **party ID** from paperwork.
3. Confirm **event date** and **city** aloud with customer before taking payment.

### Explain balance due

1. Open **party** or **member** financial view (per UI).
2. Point to **balance_due** line; explain **what is left** vs **what was paid**.
3. If **disbursement** (split payers) applies, follow **trained** checkout — do not split arbitrarily.

### Quick “is my tux ready?”

1. Find **member** row.
2. Read **pipeline** / **pickup** status from screen text only.
3. If status unclear, **Alterations** or **Orders** may have detail — get lead.

### Wedding orders in shared Orders screens

Wedding orders also appear in the shared **Orders** views.

- They should stay marked as **Wedding**, not a generic Order.
- The order detail should show the linked **party**, **member role**, and **event date**.
- Deposits, group pay, and pickup follow-up should stay tied to the linked wedding member record.
- A fully paid wedding order is not automatically ready for pickup. Staff still need to confirm measurements, receiving, and member readiness before handing anything over.
- In POS order review, treat a wedding-linked order as a member follow-up step, not a generic open order.
- Register uses the same Wedding Manager source. If a member still needs measurements, use **Measure** so the line stays **Needs measurements** until the exact variation is selected.

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

**Last reviewed:** 2026-05-14
