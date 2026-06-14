# Staff schedule, floor calendar, and related APIs

This document describes published weekly schedules, staff-submitted request-off workflow, manager-entered effective exceptions, and day-level events for schedule-eligible operational staff: **Admin**, **Salesperson**, **Sales Support**, **Staff Support**, and **Alterations**. Riverside OS is the scheduling source of truth after the one-time Excel bootstrap import.

## Migrations

| File | Purpose |
|------|---------|
| **`57_staff_schedule.sql`** | Creates **`staff_schedule_exception_kind`**, **`staff_weekly_availability`**, **`staff_day_exception`**, seeds weekly rows for active floor staff (Sun off, Mon–Sat on), and defines **`staff_effective_working_day(uuid, date)`**. |
| **`58_staff_schedule_comments.sql`** | **`COMMENT ON`** for the function and schedule tables (catalog documentation only). |
| **`064_staff_schedule_admin_effective_days.sql`** | Aligns Admin with the same published-schedule source of truth used by the schedule APIs. |
| **`083_staff_schedule_requests_and_appointment_identity.sql`** | Adds staff request-off records, request-linked effective exceptions, appointment staff identity, and appointment override/reassignment audit tables. |
| **`084_staff_birthdays_notifications.sql`** | Adds optional staff birthday month/day fields and the one-per-store-day greeting seen ledger. |

Probes: **`scripts/ros_migration_build_probes.sql`** includes **57** and **58** for **`migration-status-docker.sh`**.

## PostgreSQL function: `staff_effective_working_day(p_staff_id uuid, p_d date)`

**Returns `boolean`** — whether that staff member should be treated as **working** on calendar date **`p_d`** (no time-of-day; store-local dates are chosen in application code).

1. If **`staff`** row is missing → **`true`** (fail open).
2. If **`role`** is not **`admin`**, **`salesperson`**, **`sales_support`**, **`staff_support`**, or **`alterations`** → **`true`** (schedule rules apply only to schedule-eligible operational roles).
3. If a row exists in **`staff_day_exception`** for **`(staff_id, exception_date = p_d)`**:
   - **`extra_shift`** → **`true`**
   - Any other exception kind → **`false`**
4. Else read the published **`staff_weekly_schedule`** / **`staff_weekly_schedule_day`** row for that week and weekday.
5. If a published row exists → return its **`works`** flag.
6. If no published row exists → **`false`**. Draft or missing schedules do not count as working days.

**Consumers (non-exhaustive):**

- Task materialization and due reminders (**`server/src/logic/tasks.rs`**) — daily instances and reminders respect off days for schedule-eligible staff.
- **`open_instances_due_between`** (task due notifications) — skips reminders when the assignee is not working on **`due_date`**.
- Appointment staff validation (**`server/src/api/weddings.rs`**) when the name matches roster schedule-eligible staff.
- Alteration capacity checks (**`server/src/logic/alterations_scheduler.rs`**) require an **Alterations** staff member to be working that date.
- **`list_working_floor_staff_for_local_today`** (**`server/src/logic/staff_schedule.rs`**) — drives **`GET /api/weddings/morning-compass`** field **`today_floor_staff`**.
- Staff birthday greetings and in-app birthday notifications — only active staff with a birthday observed on the store-local date and **`staff_effective_working_day(id, date)`** generate greetings. Feb. 29 birthdays are observed on Feb. 28 in non-leap years.

If migration **57** is not applied, callers that query this function log a warning and omit data (e.g. empty **`today_floor_staff`**) where handled.

## Tables

### `staff_weekly_availability`

- **`(staff_id, weekday)`** PK, **`weekday`** 0–6, **`works`** boolean.
- Maintained from **Staff → Schedule** (PUT weekly pattern).

### `staff_day_exception`

- **`(staff_id, exception_date)`** unique.
- **`kind`** includes `sick`, `pto`, `missed_shift`, `extra_shift`, `vacation`, `doctors_appt`, `other`, `meeting`, and `store_event`.
- Optional **`notes`**, **`created_by_staff_id`**, **`created_at`**, and **`source_request_id`**.
- Manager-entered exceptions are effective immediately. Approved request-off records are converted into request-linked day exceptions. Pending, denied, and withdrawn requests do not affect effective availability.

### `staff_time_off_request`

- Staff-submitted request-off/time-away workflow.
- Stores requested staff, requested-by staff, kind, date range, optional partial-day times, staff note, status (`pending`, `approved`, `denied`, `withdrawn`), reviewer, review time, manager note, and timestamps.
- Ordinary staff may submit requests for themselves. Managers with schedule edit access may create/review requests for staff.
- Approval creates effective `staff_day_exception` rows. Denial or withdrawal removes request-linked exceptions.

### `wedding_appointments.salesperson_staff_id`

- Appointment assignment now supports stable staff identity while preserving the existing `salesperson` display string for legacy/history.
- New appointments from ROS staff selectors should send `salesperson_staff_id`; legacy name-only appointments still load and validate cautiously.

## HTTP API (`/api/staff/schedule`)

Nested under **`/api/staff`** (see **`server/src/api/staff_schedule.rs`**).

| Method | Path | Permission | Notes |
|--------|------|------------|--------|
| GET | `/eligible` | **`staff.view`** | Active schedule-eligible operational staff list. |
| GET | `/weekly/{staff_id}` | **`staff.view`** | Seven weekday rows when present. |
| PUT | `/weekly` | **`tasks.manage`** or **`staff.manage_access`** | Body: **`staff_id`**, **`weekdays`** (7 × **`weekday`**, **`works`**). |
| GET | `/exceptions` | **`staff.view`** | Query: **`staff_id`**, **`from`**, **`to`** (dates). |
| POST | `/exceptions` | **`tasks.manage`** or **`staff.manage_access`** | Upsert day exception. |
| DELETE | `/exceptions` | same | Query: **`staff_id`**, **`exception_date`**. |
| GET | `/effective` | **`staff.view`** | Query: **`staff_id`**, **`from`**, **`to`** — per-day **`working`** flags. |
| POST | `/mark-absence` | same | Sick/PTO/missed: upsert exception, cancel open **daily** task instances for that date; optional unassign or bulk reassign open same-calendar-day appointments matched by `salesperson_staff_id` first, then cautious legacy name matching. |
| GET | `/validate-booking` | **`weddings.view`** | Query: **`full_name`**, **`starts_at`** (UTC) — **`400`** if roster-matched schedule-eligible staff is off that store-local day. |
| GET/POST | `/requests` | **`staff.view`** / authenticated staff | List request history or submit request-off/time-away. |
| POST | `/requests/{id}/approve` | **`tasks.manage`** or **`staff.manage_access`** | Approves and converts request dates into effective exceptions. |
| POST | `/requests/{id}/deny` | same | Denies with required manager note. |
| POST | `/requests/{id}/withdraw` | owner for pending request, or manager | Withdraws/cancels and removes request-linked effective exceptions. |

## Excel Bootstrap Import

Excel import under **Staff → Schedule → Scheduler → Upload Excel** is a one-time bootstrap/safety workflow, not the preferred long-term scheduling workflow. After import, ROS should manage schedules directly.

The importer accepts workbook tabs named by week start/month day such as `Jun8`, `Jun15`, `APR 27`, or `Jul6`, with staff names down the left and Monday-Saturday headers across the top. Missing Sunday is imported as off.

Import safety rules:

- Blank, `OFF`, `VAC`, `VACATION`, `REQ OFF`, `REQUEST OFF`, `PTO`, `SICK`, `CALL OUT`, and `CALLOUT` are non-working.
- Real shift labels such as `9:30-6`, `10-7`, `8-5`, and `11-4` remain working shifts.
- Ambiguous non-shift text such as `HAPPY` or `4th!` blocks import until corrected. The importer does not create request-off records.

## Appointment And Absence Safety

- Appointment booking validates against effective availability by `salesperson_staff_id` when present, falling back to cautious legacy name matching only when necessary.
- Off-schedule appointment booking requires a Manager Access override reason and writes `appointment_schedule_override_audit`.
- `mark-absence` only unassigns/reassigns open appointments. `Attended`, `Missed`, `Cancelled`, and `Canceled` appointments are not touched.
- Absence-driven appointment assignment changes write `appointment_assignment_audit`.

Store timezone for “today” and appointment dates comes from **`store_settings.receipt_config.timezone`** (same as tasks / morning digest).

## Morning Dashboard: `today_floor_staff`

**`GET /api/weddings/morning-compass`** requires **authenticated staff headers** and **`weddings.view`** (same as **`GET /activity-feed`**). It returns **`MorningCompassBundle`**, which includes:

```json
"today_floor_staff": [
  { "id": "…", "full_name": "…", "role": "salesperson", "avatar_key": "…" }
]
```

- Populated from **`list_working_floor_staff_for_local_today`** (store-local **today**).
- The **Operations → Morning Dashboard** UI (**`client/src/components/operations/OperationalHome.tsx`**) renders **“Today’s floor team”** with avatars and role labels; it refreshes with the existing **1 minute** morning-board poll **only when** the signed-in user has **`weddings.view`** (otherwise the UI skips fetch and explains missing permission — see **`docs/REGISTER_DASHBOARD.md`**).

## Related docs

- **Appointments** and scheduler UX: **`docs/APPOINTMENTS_AND_CALENDAR.md`**
- **Recurring tasks** and materialization: **`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`**
- **RBAC keys** for staff routes: **`docs/STAFF_PERMISSIONS.md`**
