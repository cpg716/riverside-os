# POS Alterations

**Audience:** Staff who track alteration work from the floor.

**Where in ROS:** POS mode → left rail **Alterations** (scissors icon).

**Related permissions:** The **Alterations** rail item appears only with **alterations.manage**. Without it, use Back Office only if your role allows, or ask a manager.

---

## What this screen is for

Use **Alterations** from POS when you are **at the register** with a customer and need to **check status**, **add a quick note**, or **move a job** without walking to the back-office queue on another machine.

## How to use this screen

1. Open POS mode with an **active register session** if your store requires it for POS navigation.
2. Tap **Alterations** in the left rail.
3. Use **search or the queue list** (as your build shows) to find the job — customer name, ticket number, or due date your SOP defines.
4. Open the job to see **status**, **due date**, and **notes**. Save changes only when you are sure; some edits notify the tailor or manager.

## Common tasks

### Tell a customer if their alteration is ready

1. POS → **Alterations**.
2. Find the job (name / phone / receipt reference per SOP).
3. Read **status** aloud from the screen; do not promise dates that are not on the ticket.

### Hand off to the tailor with a note

1. Open the job.
2. Add or edit the **note** field with **who called**, **what was promised**, and **your initials**.
3. Save; confirm a success toast appears.

### Something was mis-tagged at intake

1. Do **not** delete rows on your own unless trained.
2. Add a **note** and send the customer to the alteration lead, or switch to Back Office **Alterations → Work queue** for full edits.

## Helping a coworker

- Ask: **“Do you have a ticket number or customer last name?”**
- If they cannot find the job: try **All Orders** or **Customers** for the receipt, then return to **Alterations** with the correct spelling.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| **Alterations** missing from POS rail | Your role lacks **alterations.manage** | Manager grants permission or you use BO **Alterations** |
| Queue empty but customer insists item is in | Search alternate spelling; check **Work queue** in Back Office | Alteration lead verifies intake |
| Save does nothing / error toast | Slow network: wait 10s, retry once | After second failure, note time and tell manager |
| Screen says register must be open | Open register per SOP, then retry | Lead checks session config |

## When to get a manager

- Changing **pricing** or **rush fees** on alteration orders if not in your role.
- **Lost item** or **damage** claims.
- Any instruction to **delete** history or alter **completed** jobs without audit trail.

---

## See also

- [alterations-back-office.md](alterations-back-office.md)

**Last reviewed:** 2026-04-04
