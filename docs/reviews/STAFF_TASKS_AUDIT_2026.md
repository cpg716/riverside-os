# Audit Report: Staff Task System
**Date:** 2026-04-08
**Status:** Highly Robust / Operationally Mature
**Auditor:** Antigravity

## 1. Executive Summary
The Riverside OS Task System is a "Smart Checklist" engine designed for recurring store operations. Its primary innovation is its **Lazy Materialization** strategy, which avoids creating "noise" for staff during their scheduled time off.

## 2. Technical Architecture

### 2.1 Lazy Materialization Strategy
- **Mechanism**: The `ensure_task_instances` function runs when a staff member checks their tasks.
- **Benefit**: It checks the `staff_schedule` (current day) and **materializes** the daily tasks *only* if the staff member is clocked in or scheduled to work.
- **Outcome**: A staff member who takes a long weekend won't return to 4 days of overdue "Opening Cash Count" alerts, which maintains the integrity of the data.

### 2.2 Templates & Checklist Logic
- **Checklist Engine**: Tasks are not just "titles." They contain specific, ordered items (using `sort_order`).
- **Required items**: The completion gate requires all `required = TRUE` items to be checked before the task state can flip to `completed`.
- **Completion Logging**: Every checkmark tracks `done_at` and `done_by_staff_id`, creating a clear audit trail.

### 2.3 Recurrence Engine
The system supports four distinct operational cycles:
1.  **Daily**: Morning opening / evening closing.
2.  **Weekly**: Store cleaning / deep counts.
3.  **Monthly**: Sales commission reviews.
4.  **Yearly**: Inventory reconciliation.

## 3. Operations & Team Management

### 3.1 Assignment Flexibility
- **Staff Assignment**: Direct, per-user tasks (e.g., "Review your commission payout").
- **Role Assignment**: All "Sales Support" staff get the same task (e.g., "Steam the display window").
- **Customer Linking**: Tasks can be optionally linked to a specific customer profile (`customer_id`).

### 3.2 Reporting & Boards
- **Team Board**: Managers can see a birds-eye view of all open team tasks, current assignees, and progress.
- **History View**: A searchable archive of completed tasks (`T60` retention).

## 4. Findings & Recommendations
1. **Schedule Awareness**: The tight integration with the `staff_schedule` and `Tz` (store local timezone) is excellent.
2. **Materialized Consistency**: The `title_snapshot` ensures that if a manager updates a template, it doesn't retroactively change the titles of tasks that are already in progress.
3. **Observation**: The system handles "Team Role Tasks" by creating individual instances for every staff member in that role. **Recommendation**: Consider adding "First Come, First Served" tasks for role-wide checklists.

## 5. Conclusion
The Staff Task system is a **highly operational tool** that understands the "lived reality" of retail. It is a mature implementation that provides clear accountability for management.
