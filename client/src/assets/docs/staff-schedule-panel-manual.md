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

1.  **Weekly View (Finalized Agenda)**: A read-only view of the **Published** schedule. This is what the team sees and what drives the Scheduler.
2.  **Individual View (Personnel Management)**: Detailed availability for a single staff member, including their master template, sick days, and PTO.
3.  **Planning Mode (Master Grid)**: The command center where managers build upcoming schedules, manage **Store Events**, and **Publish** the final agenda.

## When to use it

- To set a new employee's standard working hours (Master Template).
- To record a sick day or PTO (Individual View → Day Exception).
- To plan and publish a specific holiday week that deviates from the normal template (Master Template).
- To reassign appointments when a staff member is absent.

## Scheduling Hierarchy

Riverside OS calculates availability using a strict hierarchy (from highest to lowest priority):

1.  **Day Exceptions**: Explicit sick days, PTO, or extra shifts.
2.  **Published Weekly Overrides**: Per-week plans published from the Planning Mode.
3.  **Strict Privacy Invariant**: Drafts or unpublished weeks **NEVER** appear in the Weekly View or Staff Profiles. If a week is not published, staff are considered "OFF" in all public views.
4.  **Master Template**: Used as the starting point (pre-fill) for Planning Mode.

---

## Store Events, Meetings & Holidays (v0.3.4)

Managers can now track shared activities and store closures that affect the entire team.

- **Store Events Row**: A dedicated row at the top of the Planning Grid for shared events (e.g., "Memorial Day").
- **Event Types**: Use the **Type** dropdown in the event modal to categorize activities:
  - **Holiday (Closed)**: For store-wide closures. Renders in **Red** with a star (★) and large font on printouts.
  - **Store Event**: For training or special events. Renders with an **"E"** badge.
  - **Meeting**: For standard staff meetings. Renders with an **"M"** badge.
- **Unified Badges**: When a staff member is assigned to an event, a color-coded circular badge appears in their shift box:
  - **H (Red)**: Holiday.
  - **E (Green)**: Store Event.
  - **M (Amber)**: Meeting.
- **Attendance**: Events can be marked for "All Staff" or limited to selected team members.

---

## Visual Indicators (Legend)

The Planning Grid uses subtle badges and colors to provide operational warnings:

- **Conflict (Red Pulse Icon)**: Staff member has a "Request Off" (PTO, Sick, etc.) on this day. Avoid scheduling them.
- **Override (Amber Icon)**: Staff member is working on a day they are normally "OFF" in the Master Template.
- **Holiday (Red H Badge)**: Indicates a store-wide holiday or closure.
- **Event (Green E Badge)**: Indicates a store event or training.
- **Meeting (Amber M Badge)**: Linked to a Store Event. Hover to see details.
- **Highlighter (Solid Yellow)**: A manual toggle to highlight specific shifts for high-visibility printing.

---

## Weekly Planning Workflow (Planning Mode)

The Planning Mode allows you to build a specific plan for any future week without affecting the standard template.

### 1. Build the Schedule
- Select the week you want to plan using the **Next week** / **Prev week** controls.
- Use **Copy Previous Week** to pull forward the last published schedule as a starting point.

### 2. High-Visibility Printing
- Use the **Highlighter** tool to mark key shifts in bright yellow.
- These highlights are preserved in the professional print document, which also includes a specialized **Sunday Exception Box** and clear role separators.

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

