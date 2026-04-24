# Alterations (Back Office)

**Audience:** Tailors, coordinators, managers.

**Where in ROS:** Back Office → **Alterations** → **Work queue**.

**Related permissions:** **alterations.manage** for tab and queue.

---

## How to use this area

The **Work queue** is the **system of record** for garment-based alteration jobs: intake → in progress → ready → picked up. POS **Alterations** uses the same queue as Back Office.

This area tracks tailoring work orders attached to garments. The workbench starts with cards for **Overdue**, **Due Today**, **Ready for Pickup**, and **Total Open**, then groups attention by **Overdue**, **Due Today**, **Ready for Pickup**, **Intake / Not Started**, and **In Work** so staff can work the garment, not hunt by order. Alteration intake starts from the Register, where staff select the customer and source garment before checkout creates the work order. The queue still does **not** create Register charge lines, collect alteration payment, or print alteration tickets/barcodes.

## Work queue

### Work the queue

1. **Alterations** → **Work queue** → review the workbench section that needs attention.
2. Use the summary cards, search, due, source, and status filters to isolate the garment work.
3. Read the customer, garment, work requested, charge note, due date, and source context.
4. Move the status only when the physical garment actually moved.
5. Start new alteration intake from the Register.

### Read source context

- **Current sale** means the garment came from a Register sale in progress or just checked out.
- **Stock/catalog item** means the garment came from SKU lookup and is tracked for alteration only.
- **Existing order** means the source garment is tied to an open/special/wedding/custom order line.
- **Past purchase** means the source garment came from transaction history and is not being sold again.
- **Custom/manual item** means staff typed the garment description.

Order numbers appear only as source context when the garment came from a transaction line. Do not use this workbench as an order dashboard.

### Move status

1. Open job from list.
2. **In progress** when work starts; **Ready** when pressed/hung; **Picked up** when customer signs.
3. **Save** after each transition; some transitions may **notify** the customer — follow messaging policy.

### Rush or fee changes

1. Use this queue to record whether an alteration is free/included or has an optional charge note.
2. Handle actual **price**, **rush fee**, or payment collection through the approved Register/payment workflow outside this queue.
3. Register toolbar intake can link free current-cart alterations at checkout; checkout-linked alteration charges are not built yet.

## POS coordination

Floor staff use **POS → Alterations** for quick status. If POS shows **different** status than BO, **refresh** both; if still wrong, check for **duplicate** tickets.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Job missing | Alternate spelling; phone search | Check **Orders** for original sale |
| Cannot set **Ready** | Refresh and retry once | Manager checks permissions and server logs |
| Duplicate jobs | Do not delete silently | Manager reviews audit trail |
| Customer says ready, system says no | Read **rack** vs **screen** | Physical verify |

## Helping a coworker

- Give the **customer name**, **due date**, and **exact** spelling for POS lookup.
- For **phone** inquiries, verify **identity** before stating **pickup** status.

## When to get a manager

- **Damage**, **lost garment**, or **insurance** claim.
- **Waiving**, **comping**, or collecting payment for alteration work.
- **Vendor** or **tailor shop** dispute.

---

## See also

- [pos-alterations.md](pos-alterations.md)

**Last reviewed:** 2026-04-24
