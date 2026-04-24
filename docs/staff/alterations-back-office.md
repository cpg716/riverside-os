# Alterations (Back Office)

**Audience:** Tailors, coordinators, managers.

**Where in ROS:** Back Office → **Alterations** → **Work queue**.

**Related permissions:** **alterations.manage** for tab and queue.

---

## How to use this area

The **Work queue** is the **system of record** for standalone alteration jobs: intake → in progress → ready → picked up. POS **Alterations** uses the same queue as Back Office.

This area tracks tailoring work orders attached to garments. New jobs can now record the item being altered, source type, work requested, optional SKU/reference text, and optional charge note. It still does **not** create Register cart lines, collect alteration payment, print alteration tickets/barcodes, or automatically link work to checkout revenue.

## Work queue

### Intake a new job

1. **Alterations** → **Work queue** → **New** / **Intake** (per UI).
2. Select the **customer**.
3. Enter the **item source** if known: custom item, catalog/SKU item, or leave it unspecified for legacy/simple intake.
4. Enter the **item being altered** and **work requested** when staff know them.
5. Enter a **target due date** when one is known.
6. Add operational **Job Notes**.
7. Create the standalone job and confirm the success toast.

### Move status

1. Open job from list.
2. **In progress** when work starts; **Ready** when pressed/hung; **Picked up** when customer signs.
3. **Save** after each transition; some transitions may **notify** the customer — follow messaging policy.

### Rush or fee changes

1. Use this queue to record whether an alteration is free/included or has an optional charge note.
2. Handle actual **price**, **rush fee**, or payment collection through the approved Register/payment workflow outside this queue.
3. Register toolbar intake and checkout-linked alteration charges are not built yet.

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
