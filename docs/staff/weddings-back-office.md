# Weddings (Back Office)

**Audience:** Wedding managers and consultants.

**Where in ROS:** Back Office → **Weddings**. Subsections: **Action Board**, **Parties**, **Calendar**.

**Related permissions:** **weddings.view** to read; **weddings.mutate** to create/update/delete parties, members, appointments.

---

## How to use this area

Use **Weddings** to manage **groups**, **money**, and **dates** for formalwear parties. **Appointments** (sidebar) is the **store** calendar and may include non-party visits — do not confuse the two when booking.

## Action Board

**Purpose:** Pipeline view of parties/members needing attention (fittings, payments, pickups). Data comes from **`GET /api/weddings/actions`** (needs **`weddings.view`**).

1. **Weddings** → **Action Board**.
2. Use **filters** (date, balance, role) if shown.
3. Open a **card**; take the **next action** (schedule, mark fitted, link order).
4. **Balance due** may appear on a row when the party has **open order balances** (party-level total; consult **Ledger** / **Orders** before quoting exact dollars).
5. **Done** on a quick action uses the **emerald** completion style (same family as **Complete Sale** / **Post inventory**) — still confirm the right **pipeline step** before tapping.
6. Follow **pipeline rules** your store trained — skipping states breaks reporting.

**Party detail:** When marking **Measured** or **Fitting** complete, ROS may warn if a **scheduled appointment** is still open; appointment checks use a **date window** around the party (not the entire calendar) so the screen stays responsive.

**Tip:** If the board feels empty, widen **event date** or clear filters.

## Parties

**Purpose:** Search, create, and edit **wedding parties** and **members**.

1. **Weddings** → **Parties**.
2. **Search** by name, event date, or ID.
3. **Create party** → add **event date**, **location**, **notes**.
4. **Add members** (groom, groomsmen, etc.) with **roles** and **outfit** types.
5. **Link orders** when sales exist; balances flow from **orders**, not manual typing.

### Attaching Orders from Previous POS (v0.1.9)
If a customer has an order from Counterpoint (legacy) that should belong to this wedding party:
1. Go to **Back Office** → **Orders**.
2. Find the relevant order and open the detail view.
3. Click **Attach Wedding** in the action bar.
4. Select the matching **Wedding Party** and **Member** to link them.
5. Once linked, the order status and balances will reflect in the **Action Board** pipeline.

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

**Last reviewed:** 2026-04-04
