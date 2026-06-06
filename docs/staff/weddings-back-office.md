# Weddings (Back Office)

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

**Tip:** If the board feels empty, widen **event date** or clear filters.

## Readiness

**Purpose:** Answer “Is this wedding safe?” before staff promise pickup, vendor follow-up, or final release.

1. **Weddings** → **Readiness**.
2. Review parties sorted with **Critical** and **At risk** first.
3. Use filters for event window, salesperson, and readiness status.
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
| Pickup blocked until balance is cleared | Garments are ready but money is still due | Collect payment before release |
| Partial party readiness | Some members can release, others remain blocked | Release only verified ready items |

## Parties

**Purpose:** Search, create, and edit **wedding parties** and **members**.

1. **Weddings** → **Parties**.
2. **Search** by name, event date, or ID.
3. **Create party** → add **event date**, **location**, **notes**.
4. **Add members** (groom, groomsmen, etc.) with **roles** and **outfit** types.
5. **Link order lines** when sales exist; balances flow from **Transaction Records**, not manual typing.

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

Recommended review order:

1. Confirm the party and member list imported correctly.
2. Link each member to the right ROS customer.
3. Review suggested imported Transaction Records.
4. Attach the correct order lines to the member.
5. Confirm item status: **Needs measurements**, **Ready to order**, **Ordered**, **Received**, **Ready for pickup**, or **Picked up**.
6. Leave uncertain matches unresolved for manager review.

Wedding placeholder suits should stay **Needs measurements** until measurements are complete and the exact variation is selected. After review, Wedding Readiness, Orders, Inventory, and Register should all read the same ROS lifecycle state.

Full design: [../WEDDING_COUNTERPOINT_CUTOVER_LINKING.md](../WEDDING_COUNTERPOINT_CUTOVER_LINKING.md).

### Register checklist connection

Wedding Manager also feeds the POS Register.

When a customer is attached to the Register, POS shows current wedding memberships and a **Wedding Checklist** if that customer belongs to a current or unresolved party. Staff can add linked sellable items as **Take now**, **Order**, or **Measure**.

Manager setup matters:

- Set the party/member's exact ROS product variation when it is known.
- Leave placeholder suits as **Needs measurements** until the size/variation is known.
- Use checklist-only items for notes or non-catalog tasks, but do not expect POS to charge for them until they are linked to a sellable product.
- If staff report that Register only shows a checklist note, review the party/member item setup and product link.

The detailed Register behavior is documented in [../POS_WEDDING_REGISTER_WORKFLOW.md](../POS_WEDDING_REGISTER_WORKFLOW.md).

### Ledger and financial context

- **Ledger** (`party` → **Ledger**): payment-oriented detail.
- **Financial context**: snapshot for consultants — use before promising **pickup**.

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

**Last reviewed:** 2026-06-04
