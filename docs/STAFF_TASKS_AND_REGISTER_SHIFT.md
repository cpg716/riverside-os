# Staff recurring tasks and register shift primary

This document describes **saved checklist templates**, **recurring assignments** (daily / weekly / monthly / yearly), **per-staff task instances** with checklist completion, **lazy materialization** (no penalty on days off), **register shift primary** (who is “on register” vs drawer opener vs per-sale operator), RBAC, API routes, UI surfaces, **printable task records**, and **task due / overdue** notifications.

**Related:** [`docs/STAFF_PERMISSIONS.md`](./STAFF_PERMISSIONS.md) (permission keys), [`docs/PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md) (hourly generators + **`task_due_soon_bundle`**), [`docs/STAFF_SCHEDULE_AND_CALENDAR.md`](./STAFF_SCHEDULE_AND_CALENDAR.md) (floor **off days** — no daily materialization; task due reminders respect **`staff_effective_working_day`**), [`DEVELOPER.md`](../DEVELOPER.md) (migrations **55–58**, API table).

---

## Migrations

| # | File | Purpose |
|---|------|---------|
| **55** | **`55_register_shift_primary.sql`** | **`register_sessions.shift_primary_staff_id`** (nullable FK to `staff`). **`register.shift_handoff`** in **`staff_role_permission`** (admin, sales_support, salesperson). |
| **56** | **`56_staff_tasks.sql`** | Enums **`task_recurrence`**, **`task_assignee_kind`**, **`task_instance_status`**. Tables **`task_checklist_template`**, **`task_checklist_template_item`**, **`task_assignment`**, **`task_instance`**, **`task_instance_item`**. Seeds **`tasks.manage`**, **`tasks.view_team`**, **`tasks.complete`**. |
| **70** | **`070_task_assignment_ownership.sql`** | Adds **`assigned_by_staff_id`** to **`task_assignment`** and **`task_instance`** so overdue unfinished tasks can report back to the staff member who assigned them. |

Probes: **`scripts/ros_migration_build_probes.sql`** includes **55** and **56** for **`./scripts/migration-status-docker.sh`**.

---

## Register identity model

Three layers:

1. **Drawer opener** — `register_sessions.opened_by`. Only this staff may **re-issue** the POS API token (`POST /api/sessions/{id}/pos-api-token`). Audit trail for who opened the till.
2. **Shift primary (register primary)** — `register_sessions.shift_primary_staff_id`. If **NULL**, UI and task context use **`opened_by`**. If set, sidebar **cashier name/avatar**, `GET /api/sessions/current` **`cashier_*`** fields, POS **Tasks**, and notification viewer identity for that session use **`COALESCE(shift_primary_staff_id, opened_by)`** as **`register_primary_staff_id`**.
3. **Per sale** — Checkout **`operator_staff_id`** comes from the cashier verified **before ringing** on the register (**Cashier for this sale** in [`Cart.tsx`](../client/src/components/pos/Cart.tsx) via **`PosSaleCashierSignInOverlay`** + **`POST /api/staff/verify-cashier-code`**), then passed through checkout; line **`salesperson_id`** / **`primary_salesperson_id`** remain as today in [`server/src/logic/transaction_checkout.rs`](../server/src/logic/transaction_checkout.rs) / POS [`NexoCheckoutDrawer`](../client/src/components/pos/NexoCheckoutDrawer.tsx). Tender UX no longer collects a separate “staff on order” step at payment — the drawer expects the operator context from the cart. **`clearCart`** does not clear the verified cashier; only switching register **session** resets operator context.

**Handoff:** `POST /api/sessions/{session_id}/shift-primary` with `{ "cashier_code", "pin" }` (PIN rules same as POS). Gated by valid POS session token for that `session_id` **or** Back Office **`register.shift_handoff`**. Sets shift primary to the authenticated target staff; if target equals **`opened_by`**, column is cleared (**NULL**). Access log: **`register_shift_handoff`**.

**Client:** Manager mode → **Shift handoff** in [`PosShell`](../client/src/components/layout/PosShell.tsx) → [`RegisterShiftHandoffModal`](../client/src/components/pos/RegisterShiftHandoffModal.tsx). Category/customer flows that need “actor on register” use **`register_primary_staff_id`** from **`GET /api/sessions/current`** (e.g. [`CategoryManager`](../client/src/components/inventory/CategoryManager.tsx), [`CustomerRelationshipHubDrawer`](../client/src/components/customers/CustomerRelationshipHubDrawer.tsx)).

---

## Task domain (lazy materialization)

- **Templates** — Reusable titles + ordered checklist lines (`required` flag).
- **Assignments** — Template + **`task_recurrence`** (`daily` | `weekly` | `monthly` | `yearly`) + optional **`recurrence_config` JSON** + assignee **`staff`** (one `assignee_staff_id`) **or** **`role`** (all active staff with that `staff_role` at materialization time). Optional **`customer_id`**, **`starts_on` / `ends_on`**, **`active`**, and **`assigned_by_staff_id`** captured from the admin creating the assignment.
- **Instances** — Created **on demand** when the assignee first hits **`GET /api/tasks/me`** (or any code path that calls **`ensure_task_instances`** in [`server/src/logic/tasks.rs`](../server/src/logic/tasks.rs)). The notification sweep also pre-materializes **today/tomorrow due** instances so reminders do not depend on a staff member opening Tasks first. Working-day guards apply to schedule-eligible operational roles (**Admin**, **Salesperson**, **Sales Support**, **Staff Support**, and **Alterations**), so staff are not penalized for days off. Instances copy **`assigned_by_staff_id`** from the assignment at materialization time for stable reporting.
- **Period keys** — Store-local date from receipt timezone (`store_settings.receipt_config.timezone`): e.g. daily `YYYY-MM-DD`, weekly `YYYY-Www`, monthly `YYYY-MM`, yearly `YYYY`.
- **Completion** — `PATCH /api/tasks/instances/{id}/items/{item_id}` with `{ "done": true|false }`; `POST /api/tasks/instances/{id}/complete` finalizes when all **required** items are done. The shared checklist drawer shows progress and requires an explicit **Complete checklist** action after required items are checked. Assignees with **`tasks.complete`** may complete their own instances; staff with **`tasks.manage`** may complete on behalf of others.

---

## RBAC

| Key | Typical use |
|-----|-------------|
| `tasks.manage` | Create templates/assignments, edit assignment target/recurrence/date window, history, deactivate assignments; view any instance detail and complete on behalf of others. **Admin** only (seeded). |
| `tasks.view_team` | Open team board of all **open** instances with assignee avatars and read checklist detail for review. **Admin** + **sales_support**. |
| `tasks.complete` | Sidebar **Staff → Tasks** subsection; Operations **My tasks** card; implied for **`GET /api/tasks/me`** and checklist mutations for self. Seeded for **admin**, **sales_support**, **salesperson**. |
| `register.shift_handoff` | Change shift primary without closing drawer. Seeded all roles (migration **55**). |

Client: **`staff:tasks`** → **`tasks.complete`** in [`BackofficeAuthContext`](../client/src/context/BackofficeAuthContext.tsx) **`SIDEBAR_SUB_SECTION_PERMISSION`**.

---

## HTTP API (summary)

Router: **`/api/tasks`** in [`server/src/api/tasks.rs`](../server/src/api/tasks.rs).

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/tasks/me` | Staff **or** POS session; subject staff = BO authenticated id **or** **register primary** for the POS session. Materializes instances then returns **`open`** + **`completed_recent`**, including **`assigned_by_name`** and **`overdue_days`** where applicable. |
| GET | `/api/tasks/instances/{id}` | Detail + items; assignee with **`tasks.complete`**, **`tasks.view_team`**, or **`tasks.manage`**. Team viewers can inspect, but only assignee / manager can mutate. Detail includes assignment owner and overdue metadata for print/review. |
| PATCH | `/api/tasks/instances/{id}/items/{item_id}` | Body `{ "done": boolean }`. |
| POST | `/api/tasks/instances/{id}/complete` | Returns `{ "completed": true|false }`. |
| GET/POST | `/api/tasks/admin/templates` | **`tasks.manage`**. |
| GET | `/api/tasks/admin/templates/{id}/items` | **`tasks.manage`**. |
| GET/POST | `/api/tasks/admin/assignments` | **`tasks.manage`**. Rows include the template, target, customer link, active window, and **assigned by** staff. |
| PATCH | `/api/tasks/admin/assignments/{id}` | Full assignment edit: template, recurrence, assignee target, customer link, active flag, date window. **`tasks.manage`**. |
| PATCH | `/api/tasks/admin/assignments/{id}/active` | Body `{ "active": boolean }`. |
| GET | `/api/tasks/admin/team-open` | **`tasks.view_team`**. Rows include assignee avatar/name, **assigned by**, and **overdue_days**. |
| GET | `/api/tasks/admin/history` | Query `limit`, `offset`, optional `assignee_staff_id`. **`tasks.manage`**. Rows include completion status, assignee, **assigned by**, and overdue age. |

Sessions: **`POST /api/sessions/{session_id}/shift-primary`** — see [Register identity](#register-identity-model).

---

## UI surfaces

| Surface | Location |
|---------|----------|
| Staff hub | **Staff → Tasks** — [`StaffTasksPanel`](../client/src/components/staff/StaffTasksPanel.tsx): My tasks, Team (if **`tasks.view_team`**), Admin (if **`tasks.manage`**). Admin template builder uses row-based checklist steps with required/optional toggles and recurrence guidance. My/team/history task lists are printable. |
| Operations | **Morning Dashboard** — [`OperationalHome`](../client/src/components/operations/OperationalHome.tsx): **My tasks** card when **`tasks.complete`**; **Today’s floor team** from **`GET /api/weddings/morning-compass`** field **`today_floor_staff`** (schedule migrations **57–58** — see [`STAFF_SCHEDULE_AND_CALENDAR.md`](./STAFF_SCHEDULE_AND_CALENDAR.md)). |
| POS | **PosSidebar → Dashboard** — [`RegisterDashboard`](../client/src/components/pos/RegisterDashboard.tsx): task preview + open checklist drawer when **`tasks.complete`**; default tab on new session per [`PosShell`](../client/src/components/layout/PosShell.tsx). **PosSidebar → Tasks** — [`RegisterTasksPanel`](../client/src/components/tasks/RegisterTasksPanel.tsx) when register is open; uses merged BO + POS headers. |
| Shared checklist | [`TaskChecklistDrawer`](../client/src/components/tasks/TaskChecklistDrawer.tsx). Shows assigned-by and overdue metadata, supports item completion, final checklist completion, and a printable checklist/sign-off sheet. |

Avatars: team board and history use **`staffAvatarUrl`** / **`assignee_avatar_key`** from roster joins.

---

## Notifications

Hourly generator **`run_task_due_reminders`** in [`server/src/logic/notifications_jobs.rs`](../server/src/logic/notifications_jobs.rs):

- Pre-materializes active assignments due **store-local today or tomorrow** for working staff.
- Upserts one **`app_notification`** per assignee per store-local day, kind **`task_due_soon_bundle`**, **`notification_bundle`** payload (per-instance nested deep links; often **`staff_tasks`** + **`instance_id`**), fan-out to the assignee.
- Finds **open overdue** instances with **`assigned_by_staff_id`** and sends one assigner bundle per day, kind **`task_overdue_assigned_bundle`**, so the person who assigned the work sees what remains unfinished and who it is assigned to.
- Clears prior bundles for the same staff/day before recreating them. See [`docs/PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md).

---

## E2E

[`client/e2e/staff-tasks.spec.ts`](../client/e2e/staff-tasks.spec.ts) — Back Office **Staff → Tasks** reaches **My tasks** panel (requires API, baseline task schema, and staff permissions).

---

## Operational checklist

1. Apply migrations **55**, **56**, and **70** (`./scripts/apply-migrations-docker.sh`).
2. Create at least one **template** and **assignment** (Staff → Tasks → Admin) as an **admin**.
3. Confirm assignees see tasks on **Operations** and/or **Register → Tasks** after materialization (first fetch).
4. Print one task detail and one open team list when paper sign-off is needed.
5. Leave a test task overdue and confirm the assigning admin receives **Assigned tasks overdue** in Notifications.
6. Use **Shift handoff** when the person on the floor changes but the same drawer session stays open.
