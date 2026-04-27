---
id: staff-schedule-panel
title: "Staff Schedule"
order: 1108
summary: "Manage the store-wide schedule, individual staff availability, and per-week planning overrides."
source: client/src/components/staff/StaffSchedulePanel.tsx
tags: staff, schedule, availability, shifts, team
status: approved
---

# Staff Schedule

The Staff Schedule workspace is the authoritative source for team availability in Riverside OS. It manages when consultants and tailors are working, which in turn controls appointment booking in the Scheduler and task assignments.

![Staff Schedule Overview](../images/help/staff-schedule/main.png)

## What this is

This workspace is divided into three primary modes to balance long-term planning with daily operational needs:

1.  **Weekly View (Store Agenda)**: The master calendar showing every floor staff member's working status for a specific week.
2.  **Individual View (Personnel Management)**: Detailed availability for a single staff member, including their master template, sick days, and PTO.
3.  **Master Template (Planning & Overrides)**: The "planning board" where managers build the upcoming schedule, import from Excel, and **Publish** overrides for future weeks.

## When to use it

- To set a new employee's standard working hours (Master Template).
- To record a sick day or PTO (Individual View → Day Exception).
- To plan and publish a specific holiday week that deviates from the normal template (Master Template).
- To reassign appointments when a staff member is absent.

## Scheduling Hierarchy

Riverside OS calculates availability using a strict hierarchy (from highest to lowest priority):

1.  **Day Exceptions**: Explicit sick days, PTO, or extra shifts.
2.  **Published Weekly Overrides**: Per-week plans published from the Master Template.
3.  **Master Template**: The standard recurring availability defined in the Individual View.
4.  **Default OFF**: If none of the above are set, the staff member is considered off.

---

## Weekly Planning Workflow (Master Template)

The Master Template mode allows you to build a specific plan for any future week without affecting the standard template.

### 1. Build the Schedule
- Navigate to the **Master** tab.
- Select the week you want to plan using the **Next week** / **Prev week** controls.
- By default, the grid shows values from the standard template.

### 2. Import or Edit
- **Manual Entry**: Click the toggles or type shift labels (e.g., "9-5") directly in the grid.
- **Excel Import**: Click **Upload Excel** to parse an existing spreadsheet. The system uses fuzzy matching to link names (e.g., "Tom Z" will match "Tom Zotos").

### 3. Save as Draft
- Click **Save All Changes**. The week is now saved as a **Draft**. Drafts are visible to managers but do not yet affect the live Scheduler or register sign-ins.

### 4. Publish Week
- Once the plan is finalized, click **Publish Week**. 
- The schedule is now live and will override the standard template for that specific week only.

### 5. Clear Overrides
- If you need to revert a specific week back to the standard template, click **Clear Overrides**. This deletes any draft or published overrides for that week.

---

## Recording Absences & Reassigning Work

When a staff member is sick or on PTO, use the **Individual View** to record the absence and manage their existing workload.

1.  Select the staff member in **Individual View**.
2.  Scroll to the **Mark sick / absence** section.
3.  Select the **Date** and **Type** (Sick, PTO, Missed Shift).
4.  **Manage Appointments**:
    *   **Leave as-is**: No changes to existing appointments.
    *   **Unassign**: Removes the staff member from their appointments, marking them as needing reassignment in the Scheduler.
    *   **Reassign to teammate**: Automatically moves all appointments for that day to another working staff member.
5.  Click **Record Absence**. This also cancels any daily checklist tasks for that staff member on that day.

## What to watch for

- **Unsaved Changes**: You must save your draft before the **Publish Week** button becomes available.
- **Ambiguous Names**: During Excel import, names like "Tom" may be flagged if multiple staff members share that first name. Use first names with initials (e.g., "Tom L") in your spreadsheets for better matching.
- **Published Lock**: Once a week is published, any further edits will revert the status back to **Draft** until you publish again.

## Related workflows

- [Scheduler Workspace](manual:scheduler-workspace)
- [Staff Tasks](manual:tasks-team-tasks-drawer)
- [Team Roster](manual:staff-workspace)

