---
id: staff-weekly-grid-view
title: "Staff Weekly Grid View"
order: 1133
summary: "Professional printing, store event management, and unified badge reference for the weekly schedule."
source: client/src/components/staff/StaffWeeklyGridView.tsx
tags: staff, schedule, grid, printing, events
status: approved
---

# Staff Weekly Grid View

The Weekly Grid View is the primary interactive surface for building and printing your store's weekly agenda. It provides a high-density overview of all staff shifts, store events, and operational warnings.

![Weekly Grid Overview](../images/help/staff-weekly-grid-view/main.png)

## What this is

This view acts as the "Command Center" for the Weekly Schedule. It allows you to:
- Build upcoming schedules using the Master Template or by copying previous weeks.
- Manage shared **Store Events**, **Meetings**, and **Holidays**.
- Print professional, high-fidelity schedules for physical posting.

## Professional Printing

Riverside OS includes a specialized print engine designed for store-room posting:
- **Numerical Dates**: Header labels include the day of the month (e.g., "Mon 27").
- **Unified Event Badges**: Shift boxes include color-coded badges for easy recognition:
  - **[HOLIDAY]** (Red): Store-wide closures.
  - **[EVENT]** (Green): Shared store activities or training.
  - **[MEETING]** (Amber): Staff meetings.
- **Role Separators**: The printout automatically groups staff by their role (Salesperson, Tailor, etc.) for better organization.
- **Custom Non-Working Labels**: If a staff member is off for a specific reason (e.g., **VAC**, **REQ OFF**), the printout will reflect that specific reason instead of a generic "OFF".

## Managing Store Events

Use the **Store Events** row at the top of the grid to manage shared activities:
1. Click **+ Add Event** on the desired day.
2. Select the **Type**:
   - **Holiday (Closed)**: Automatically centers the label and uses a large bold font on printouts.
   - **Store Event**: For activities like "Inventory Training".
   - **Meeting**: For standard recurring meetings.
3. Choose **Attendance** (All Staff or Selected Staff).
4. Click **Save Event**. Attendees will automatically receive the corresponding badge in their shift cell.

## What to watch for

- **Published Status**: Only weeks marked as **Published** are visible to the general staff. Always remember to click **Publish Week** after finalizing your draft.
- **Red Conflicts**: If you see a pulsing red icon, it means a staff member has an approved "Request Off" that overlaps with a scheduled shift.
- **Star Icons (★)**: These indicate store-wide holidays and closures.

## Related workflows

- [Staff Workspace](manual:staff-workspace)
- [Staff Schedule Panel](manual:staff-schedule-panel)

