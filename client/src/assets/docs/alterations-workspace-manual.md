---
id: alterations-workspace
title: "Alterations Hub"
order: 1120
summary: "Manage the tailoring workflow, track work queues, process intakes, and oversee garment pickup status."
source: client/src/components/alterations/AlterationsWorkspace.tsx
last_scanned: 2026-04-17
tags: alterations, tailoring, intake, work-queue, status, tickets
---

# Alterations (Back Office)

_Audience: Tailors, coordinators, managers._

**Where in ROS:** Back Office → **Alterations** → **Work queue**.

---

## How to use this area

The **Work queue** is the **system of record** for alteration jobs: intake → in progress → ready → picked up. This workspace handles complex edits and due-date management.

## Work Queue Management

### Intake a New Job
1. **Alterations** → **Work queue** → **New / Intake**.
2. Link the **customer** and the specific **order line** or SKU.
3. Enter the **due date**, **work type** (hem, taper, sleeve, rush), and detailed **notes** (fabric, thread, pin height).
4. Print the **tailor ticket** or barcode label for rack scanning.

### Moving Statuses
1. Open the job from the list.
2. **In Progress**: Set when work starts.
3. **Ready**: Set when the garment is pressed, hung, and ready for pickup.
4. **Picked Up**: Set when the customer physically receives the garment.
5. **Save** after each transition; certain transitions may trigger automated customer notifications.

## Fees and Overrides
- Only authorized roles should change the **price** or **promise date**.
- Always add a note specifying **who approved** the change and the **rationale**.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Job missing** | Search by alternate spelling or phone number; verify the original sale in Orders. |
| **Cannot set "Ready"** | Check for empty required fields or missing measurements. |
| **Duplicate tickets** | Do not delete; have a manager merge the duplicate records. |
| **Status mismatch** | If POS and Back Office disagree, refresh both browsers to clear local cache. |

**Last reviewed:** 2026-04-17
