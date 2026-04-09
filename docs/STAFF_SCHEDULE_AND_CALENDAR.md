# Staff schedule, floor calendar, and related APIs

This document describes **salesperson / sales support** weekly patterns and day exceptions, the PostgreSQL function that decides “working or not,” REST endpoints under **`/api/staff/schedule`**, and how the **Operations Morning Dashboard** surfaces **today’s floor team**.

## Migrations

| File | Purpose |
|------|---------|
| **`57_staff_schedule.sql`** | Creates **`staff_schedule_exception_kind`**, **`staff_weekly_availability`**, **`staff_day_exception`**, seeds weekly rows for active floor staff (Sun off, Mon–Sat on), and defines **`staff_effective_working_day(uuid, date)`**. |
| **`58_staff_schedule_comments.sql`** | **`COMMENT ON`** for the function and schedule tables (catalog documentation only). |

Probes: **`scripts/ros_migration_build_probes.sql`** includes **57** and **58** for **`migration-status-docker.sh`**.

## PostgreSQL function: `staff_effective_working_day(p_staff_id uuid, p_d date)`

**Returns `boolean`** — whether that staff member should be treated as **working** on calendar date **`p_d`** (no time-of-day; store-local dates are chosen in application code).

1. If **`staff`** row is missing → **`true`** (fail open).
2. If **`role`** is not **`salesperson`** or **`sales_support`** → **`true`** (schedule rules apply only to floor roles).
3. If a row exists in **`staff_day_exception`** for **`(staff_id, exception_date = p_d)`**:
   - **`extra_shift`** → **`true`**
   - **`sick`**, **`pto`**, **`missed_shift`** → **`false`**
4. Else read **`staff_weekly_availability`** for **`weekday = EXTRACT(DOW FROM p_d)`** (0 = Sunday … 6 = Saturday).
5. If a weekly row exists → return its **`works`** flag.
6. If no weekly row → default **Sunday off**, other days **on** (same as migration **57** seed).

**Consumers (non-exhaustive):**

- Task materialization for floor roles (**`server/src/logic/tasks.rs`**) — no new daily instances on off days.
- **`open_instances_due_between`** (task due notifications) — skips reminders when the assignee is not working on **`due_date`**.
- Appointment salesperson validation (**`server/src/api/weddings.rs`**) when the name matches roster floor staff.
- **`list_working_floor_staff_for_local_today`** (**`server/src/logic/staff_schedule.rs`**) — drives **`GET /api/weddings/morning-compass`** field **`today_floor_staff`**.

If migration **57** is not applied, callers that query this function log a warning and omit data (e.g. empty **`today_floor_staff`**) where handled.

## Tables

### `staff_weekly_availability`

- **`(staff_id, weekday)`** PK, **`weekday`** 0–6, **`works`** boolean.
- Maintained from **Staff → Schedule** (PUT weekly pattern).

### `staff_day_exception`

- **`(staff_id, exception_date)`** unique.
- **`kind`**: `sick` | `pto` | `missed_shift` | `extra_shift`.
- Optional **`notes`**, **`created_by_staff_id`**, **`created_at`**.

## HTTP API (`/api/staff/schedule`)

Nested under **`/api/staff`** (see **`server/src/api/staff_schedule.rs`**).

| Method | Path | Permission | Notes |
|--------|------|------------|--------|
| GET | `/eligible` | **`staff.view`** | Active salesperson / sales_support list. |
| GET | `/weekly/{staff_id}` | **`staff.view`** | Seven weekday rows when present. |
| PUT | `/weekly` | **`tasks.manage`** or **`staff.manage_access`** | Body: **`staff_id`**, **`weekdays`** (7 × **`weekday`**, **`works`**). |
| GET | `/exceptions` | **`staff.view`** | Query: **`staff_id`**, **`from`**, **`to`** (dates). |
| POST | `/exceptions` | **`tasks.manage`** or **`staff.manage_access`** | Upsert day exception. |
| DELETE | `/exceptions` | same | Query: **`staff_id`**, **`exception_date`**. |
| GET | `/effective` | **`staff.view`** | Query: **`staff_id`**, **`from`**, **`to`** — per-day **`working`** flags. |
| POST | `/mark-absence` | same | Sick/PTO/missed: upsert exception, cancel open **daily** task instances for that date; optional unassign or bulk reassign same-calendar-day appointments matched by **`full_name`**. |
| GET | `/validate-booking` | **`weddings.view`** | Query: **`full_name`**, **`starts_at`** (UTC) — **`400`** if roster-matched floor staff is off that store-local day. |

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
