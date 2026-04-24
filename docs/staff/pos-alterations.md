# POS Alterations

**Audience:** Staff who track alteration work from the floor.

**Where in ROS:** POS mode → left rail **Alterations** (scissors icon).

**Related permissions:** The **Alterations** rail item appears only with **alterations.manage**. Without it, use Back Office only if your role allows, or ask a manager.

---

## What this screen is for

Use **Alterations** from POS when you are **at the register** with a customer and need to **check status**, **intake a standalone tailoring job**, or **move a job** without walking to the back-office queue on another machine.

This screen shares the same alterations queue as Back Office. It can record the garment/source, work requested, optional SKU/reference text, and whether a charge was noted. Free alterations started from a current Register cart item are linked to the checkout transaction when the sale completes. It does **not** add alteration charges to the Register cart or create alteration service lines yet.

## How to use this screen

1. Open POS mode with an **active register session** if your store requires it for POS navigation.
2. Tap **Alterations** in the left rail.
3. Use the queue filters (**All**, **Intake**, **In Work**, **Ready**, **Picked Up**) to narrow the list.
4. Review **customer**, **item**, **work requested**, **source**, **charge note**, **status**, **due date**, and **notes**. Save status changes only when you are sure; marking a job **Ready** may notify the customer.

## Common tasks

### Tell a customer if their alteration is ready

1. POS → **Alterations**.
2. Find the job (name / phone / receipt reference per SOP).
3. Read **status** aloud from the screen; do not promise dates that are not on the ticket.

### Hand off to the tailor with a note

1. For a new standalone job, select the customer, enter the item/source and work requested if known, set a target due date if known, and add any tailoring context in **Job Notes**.
2. For an existing job, use the visible item/work/source information and note to confirm context before changing status.
3. Confirm a success toast appears after creating the job or changing status.

### Something was mis-tagged at intake

1. Do **not** delete rows on your own unless trained.
2. Add a **note** and send the customer to the alteration lead, or switch to Back Office **Alterations → Work queue** for full edits.

## Helping a coworker

- Ask: **“Do you have the customer name or due date?”**
- If they cannot find the job: try **All Orders** or **Customers** for the receipt, then return to **Alterations** with the correct spelling.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| **Alterations** missing from POS rail | Your role lacks **alterations.manage** | Manager grants permission or you use BO **Alterations** |
| Queue empty but customer insists item is in | Search alternate spelling; check **Work queue** in Back Office | Alteration lead verifies intake |
| Save does nothing / error toast | Slow network: wait 10s, retry once | After second failure, note time and tell manager |
| Screen says register must be open | Open register per SOP, then retry | Lead checks session config |

## When to get a manager

- Any customer-facing promise about **price**, **rush fees**, or cart charges. This screen can record an optional charge note, but it does not collect alteration payment or create Register cart lines.
- **Lost item** or **damage** claims.
- Any instruction to **delete** history or alter **completed** jobs without audit trail.

---

## See also

- [alterations-back-office.md](alterations-back-office.md)

**Last reviewed:** 2026-04-24
