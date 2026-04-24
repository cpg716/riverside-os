# Alterations (Back Office)

**Audience:** Tailors, coordinators, managers.

**Where in ROS:** Back Office → **Alterations** → **Work queue**.

**Related permissions:** **alterations.manage** for tab and queue.

---

## How to use this area

The **Work queue** is the **system of record** for standalone alteration jobs: intake → in progress → ready → picked up. POS **Alterations** uses the same queue as Back Office.

This area currently tracks tailoring work only. It does **not** create Register cart lines, collect alteration payment, print alteration tickets/barcodes, or automatically link work to a transaction line.

## Work queue

### Intake a new job

1. **Alterations** → **Work queue** → **New** / **Intake** (per UI).
2. Select the **customer**.
3. Enter a **target due date** when one is known.
4. Enter the tailoring instructions in **Job Notes**.
5. Create the standalone job and confirm the success toast.

### Move status

1. Open job from list.
2. **In progress** when work starts; **Ready** when pressed/hung; **Picked up** when customer signs.
3. **Save** after each transition; some transitions may **notify** the customer — follow messaging policy.

### Rush or fee changes

1. Use this queue for status and due-date tracking only.
2. Handle **price**, **rush fee**, or payment questions through the approved Register/payment workflow outside this queue.

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
