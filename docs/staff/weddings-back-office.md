# Weddings (Back Office)

## Lifecycle source of truth

The Wedding Hub derives Ordered, Received, Ready for Pickup, and Picked Up from each member's non-takeaway Transaction/Fulfillment Order lines. Staff cannot complete those stages by toggling a party-grid flag. Open the member, then continue in Register or Orders so receiving, alterations, shipping, pickup, payments, and receipts retain the same source identifiers.

The open party tracker refreshes from ROS every minute, when the app regains focus, and when Wedding or appointment events arrive. Customer contact data comes from the linked Customer; purchased item descriptions and fulfillment come from Transaction lines; payment status comes from Transactions, payment allocations, source-tracked held deposits, and current `balance_due`; appointment counts come from ROS wedding appointments. **Paid** requires a linked Transaction with no balance due. A held deposit remains **Deposit** until Register applies it to the member's Transaction.

Measurements and fittings remain operational milestones. Marking a linked Measurement or Fitting appointment Attended updates the appointment and member milestone atomically. Pickup appointments never complete fulfillment; use Orders/Register.

ROS uses the authenticated staff identity for wedding mutations and records party/member updates with their activity entry in the same database transaction. Appointment conflict overrides require Manager Access plus a written reason.

## Archive inactive wedding tracking

For a passed, cancelled, incomplete, duplicate/test, or pre-ROS wedding tracker, use **Archive Tracking** instead of manually marking workflow stages complete. The manager records a tracking outcome, required reason, optional notes, and explicitly acknowledges linked ROS work shown in the read-only snapshot.

The Wedding Hub does not own or write the linked Transactions, balances, deposits, fulfillment lines, appointments, alterations, shipments, or customer history. It aggregates their current state for tracking. Archiving changes only the wedding tracking record and writes an authenticated `WEDDING_TRACKING_ARCHIVED` activity entry. Archived trackers are listed under **Closed / Archived** and can be reopened with Manager Access; reopening clears the current archive marker but retains the historical activity entry.

**Audience:** Wedding managers and consultants.

**Where in ROS:** Back Office → **Weddings**. Subsections: **Action Board**, **Parties**, **Calendar**, **Readiness**, and **Cutover Review**.

**Related permissions:** **weddings.view** to read wedding data; **weddings.mutate** to create/update/delete parties, members, appointments; **wedding_manager.open** to open the full Wedding Manager shell/tab from navigation.

---

## How to use this area

Use **Weddings** to manage **groups**, **money**, and **dates** for formalwear parties. **Appointments** (sidebar) is the **store** calendar and may include non-party visits — do not confuse the two when booking.

## Action Board

**Purpose:** Pipeline view of parties/members needing attention (fittings, payments, pickups). Data comes from **`GET /api/weddings/actions`** (needs **`weddings.view`**).

1. **Weddings** → **Action Board**.
2. Use **filters** (date, balance, role) if shown.
3. Open a **card**; take the **next action** (schedule, mark fitted, link order).
4. **Balance due** may appear on a row when the party has **open Transaction Record balances** (party-level total; consult **Ledger** / **Transaction Records** before quoting exact dollars).
5. **Done** on a quick action uses the **emerald** completion style (same family as **Complete Sale** / **Post inventory**) — still confirm the right **pipeline step** before tapping.
6. Follow **pipeline rules** your store trained — skipping states breaks reporting.

**Party detail:** When marking **Measured** or **Fitting** complete, ROS may warn if a **scheduled appointment** is still open; appointment checks use a **date window** around the party (not the entire calendar) so the screen stays responsive.

When you create, edit, delete, or mark wedding appointments attended from ROS, the system records the authenticated staff member automatically. You should not need to choose a separate "recording staff" identity.

Where Wedding Manager asks you to assign or filter by a salesperson, use the ROS staff mini selector with avatars. The list comes from active ROS staff records, not a separate Wedding Manager staff list.

**Tip:** If the board feels empty, widen **event date** or clear filters.

## Readiness

**Purpose:** Answer “Is this wedding safe?” before staff promise pickup, vendor follow-up, or final release.

1. **Weddings** → **Readiness**.
2. Review parties sorted with **Critical** and **At risk** first.
3. Use filters for event window, salesperson, and readiness status. The salesperson filter uses the ROS staff mini selector.
4. Open a party card to view the party-level readiness panel.
5. Resolve blockers in the source workflow: vendor ordering in **Orders / PO receiving**, payment in the **Transaction Record**, and release in the guarded **Pickup** workflow.

Readiness uses existing ROS truth. It does not move lifecycle states automatically.

Party detail also shows **✨ ROSIE readiness takeaways** from the visible milestone and readiness data. These takeaways group the highest-level risks, such as missing measurement appointments, missing orders, receiving blockers, or balance holds. They do not update member status, collect money, release garments, or replace the readiness panel.

Common readiness labels:

| Label | Meaning | Next action |
|-------|---------|-------------|
| Needs vendor order | One or more items are still NTBO | Create or attach vendor purchase orders |
| Vendor delay risk | Ordered items are stale or past ETA | Call vendor and update ETA |
| Ready for pickup | Garments are verified ready | Use guarded pickup workflow |
| Pickup needs payment approval | Garments are ready but money is still due | Collect payment or use Manager Access |
| Partial party readiness | Some members can release, others remain blocked | Release only verified ready items |

## Parties

**Purpose:** Search, create, and edit **wedding parties** and **members**.

1. **Weddings** → **Parties**.
2. **Search** by name, event date, or ID.
3. **Create party** → add **event date**, **location**, **notes**, and assign the salesperson with the ROS staff mini selector.
4. Search current ROS Customers for the Groom and every additional member. Select the matching Customer account when it exists. If there is no match, enter separate **First Name** and **Last Name** fields to quick-add a new Customer account.
5. Choose the member type from the role list (**Groom**, **Groomsman**, **Father**, **Child**, or another listed type). Choose **Other** and enter the role only when needed.
6. Use **Save & Start Groom Wedding Order** from New Party, or **Add/Save & Start Wedding Order** from Party Management, to save the link and open that exact member in Register immediately. Checkout remains the only action that creates the financial Transaction Record.
7. **Link order lines** when sales exist; balances flow from **Transaction Records**, not manual typing.

Member names, phone numbers, and email addresses are owned by the linked Customer account. Edit those details in Customers so Wedding Manager, Register, history, and messaging continue to show the same identity.

Party search waits for a short typing pause. The loaded party cards remain visible with an
**Updating…** status while the newest results arrive, so a slow PWA connection does not make the
Wedding Party Hub appear to reload after every letter.

### Attaching Counterpoint Transaction Records (v0.1.9)
If a customer has a Counterpoint Transaction Record or fulfillment line that should belong to this wedding party:
1. Go to **Back Office** → **Orders**.
2. Find the relevant Transaction Record or open order work and open the detail view.
3. Click **Attach Wedding** in the action bar.
4. Select the matching **Wedding Party** and **Member** to link them.
5. Once linked, the fulfillment status and Transaction Record balances will reflect in the **Action Board** pipeline.

### Mid-season Counterpoint cutover

If ROS starts while weddings are already in progress, managers should use **Cutover Review** before trusting party readiness.

Plain rule: **do not retype money into Wedding Manager.** Counterpoint-synced Transaction Records carry the paid amount, balance, and line items. Staff only confirm which party/member owns each imported sale or fulfillment line and where each item currently stands.

Imported worksheet rows that are instructions, notes, or suit/color comments are kept as party notes. They should not create party members. Worksheet status cells from paper workflows, such as received/fitted/picked-up markings, do not automatically mark ROS member workflow steps complete; use **Cutover Review** to confirm those states after the import. When a worksheet row has a phone number, ROS only auto-verifies an existing customer link when the normalized phone and customer name identify one matching customer. Ambiguous phone matches stay in review instead of being silently attached.

Recommended review order:

1. Confirm the party and member list imported correctly.
2. Link each member to the right ROS customer.
3. Review suggested imported Transaction Records.
4. Attach the correct order lines to the member.
5. Select the exact Transaction Record lines (maximum 100) and confirm a status through **Ready for pickup**.
6. Complete the Manager Access approval. An empty line selection is never treated as all lines.
7. Complete **Picked Up** only through Register pickup so inventory, revenue, commissions, loyalty, and audit move together.
8. Leave uncertain matches unresolved for manager review.

Wedding placeholder suits should stay **Needs measurements** until measurements are complete and the exact variation is selected. After review, Wedding Readiness, Orders, Inventory, and Register should all read the same ROS lifecycle state.

Full design: [../WEDDING_COUNTERPOINT_CUTOVER_LINKING.md](../WEDDING_COUNTERPOINT_CUTOVER_LINKING.md).

### Register checklist connection

Wedding Manager also feeds the POS Register.

When a customer is attached to the Register, POS shows current wedding memberships and asks **Part of the Wedding Order?** for an active member. **Yes — Build Wedding Order** loads the party's parent-item checklist and exact-variation workflow; **No — Regular Sale** creates no Wedding or financial record. After acceptance, staff can add linked sellable items as **Take now**, **Order**, or **Measure**, add exceptions or alterations, and explicitly apply any source-tracked held deposit from **Pay**. Only successful checkout posts the member Transaction Record and Wedding Fulfillment Order.

Manager setup matters:

- Set the party/member's exact ROS product variation when it is known.
- In **New Wedding Party** or **Style & Order Details**, select the party's sellable **Wedding Builder parent items** from the ROS catalog. Mark each item **All**, **Groom Only**, **Groomsmen Only**, **Any**, or **Other**. Register and Deposit & Build then show only the products applicable to the loaded member before asking for the exact size/variation.
- Leave placeholder suits as **Needs measurements** until the size/variation is known.
- Use checklist-only items for notes or non-catalog tasks, but do not expect POS to charge for them until they are linked to a sellable product.
- If staff report that Register only shows a checklist note, review the party/member item setup and product link.

The detailed Register behavior is documented in [../POS_WEDDING_REGISTER_WORKFLOW.md](../POS_WEDDING_REGISTER_WORKFLOW.md).

### Ledger and financial context

- **Ledger** (`party` → **Ledger**): payment-oriented detail.
- **Financial context**: snapshot for consultants — use before promising **pickup**.

### Removal audit trail

Removing a member, party appointment, or checklist-only non-inventory item is not a silent cleanup action. ROS writes a wedding activity entry with the removed record details before the removal commits, so managers can reconstruct what changed later. If a removal fails, refresh the party before trying again and do not recreate the record until the activity feed confirms the current state.

## Calendar

**Purpose:** Party-centric **milestones** and internal dates (fittings, final pickup).

1. **Weddings** → **Calendar**.
2. Click a date to see **party-linked** items.
3. For **walk-in** or **non-party** slots, prefer **Appointments → Scheduler**.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Party not found | Spelling; **event year** | Browse **Parties** list |
| Balance mismatch | Open linked **Orders** | Finance lead |
| Cannot delete member | **Orders** still attached | Manager |
| Board slow | Narrow filters | Network / IT |

## Helping a coworker

- Share **party ID** or **event date** verbally to avoid wrong family merged.
- For **phone** balance quotes, read **exact** screen text; round **up** to nearest policy if instructed.

## When to get a manager

- **Contract** or **deposit** disputes.
- **Deleting** a party with **live** orders.
- **Refund** across **multiple** payers (disbursements).

---

## See also

- [pos-weddings.md](pos-weddings.md)
- [appointments.md](appointments.md)
- [../WEDDING_GROUP_PAY_AND_RETURNS.md](../WEDDING_GROUP_PAY_AND_RETURNS.md)

**Last reviewed:** 2026-06-21
