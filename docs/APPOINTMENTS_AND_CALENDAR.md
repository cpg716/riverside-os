# Appointments & calendar (ROS + Wedding Manager)

## Storage (single source of truth)

All scheduled slots live in PostgreSQL table **`wedding_appointments`**, exposed under **`/api/weddings/appointments`**. Day/week grids in different UIs read and write the same rows.

Podium is a notification transport for enabled appointment confirmations, reminders, and `.ics` calendar attachments. ROS does not mirror booking state into a separate Podium appointment calendar; appointment creation, rescheduling, status, staff assignment, and wedding linkage remain authoritative in ROS.

## Two entry points in the client

| Surface | Component(s) | Primary intent |
|--------|----------------|----------------|
| **Back Office → Appointments** (sidebar) | `client/src/components/scheduler/SchedulerWorkspace.tsx`, `AppointmentModal.tsx` | **General store calendar**: measurements, fittings, consultations, events, walk-ins. Bookings default to **customer on file** only (`customers.id` via optional `customer_id` on the row). |
| **Wedding Manager** (embedded) | `client/src/components/wedding-manager/components/AppointmentScheduler.jsx` + shared `client/src/components/scheduler/AppointmentModal.tsx` | **Wedding-centric** schedule view using the same appointment creator/editor as the main store calendar. |

Do not assume the sidebar calendar is “wedding-only”: staff should treat it as the **store** schedule unless they explicitly use **Link wedding party** in the ROS modal (see below).

Day/week scheduler grids and printed schedules show **open** appointments only. **Attended**, **Missed**, **Cancelled**, and **Canceled** rows remain in history/search, but they do not keep blocking the live booking grid.

Migration **`192_appointment_system_hardening.sql`** adds authoritative end times, service types, room/resource capacity, optimistic revisions, cancellation metadata, and append-only appointment audit rows. Scheduled staff/resource overlaps are checked inside the same database transaction as create/update. An intentional overlap requires Manager Access plus a reason and remains separately auditable.

## Migration 33 — walk-in / general appointments

**`migrations/legacy_prelaunch_history/33_wedding_appointments_walk_in.sql`**:

- `wedding_party_id` and `wedding_member_id` are **nullable** (previously required).
- Adds **`customer_id`** → `customers(id)` (nullable) for CRM linkage without a party row.

**`POST /api/weddings/appointments`** (`CreateAppointmentRequest` in `server/src/api/weddings.rs`):

- **`wedding_member_id`**: optional. When set, party is derived from the member (party-linked appointment).
- When **omitted**, at least **`customer_display_name` or `phone`** must be present (walk-in / general).
- **`customer_id`**: optional UUID; stored when the booking is tied to a ROS customer record.

Customer **timeline** appointments query includes rows where `wedding_appointments.customer_id` matches **or** the appointment is linked via `wedding_members.customer_id`.

## Customer search when booking

**`GET /api/customers/search?q=`** (min 2 characters) returns slim **`Customer`** rows including:

- `wedding_party_id`, `wedding_party_name`, `wedding_active`
- **`wedding_member_id`** — member row for the same “active upcoming party” used for party id (when applicable)

Optional query params: **`limit`** (default **25**, max **100**), **`offset`** — for paging when many rows match. The scheduler modal uses a larger first page plus **Load more**; see **`docs/SEARCH_AND_PAGINATION.md`**.

### Shared ROS `AppointmentModal` behavior

- Search uses the authenticated Customer browse endpoint with debouncing, cancellation of superseded requests, and a visible unavailable state.
- Selecting a hit fills **name / phone / `customer_id`** by default (**no** automatic wedding-member link).
- The selected customer name remains visible in the input and the result dropdown closes after selection.
- If the customer has an active party, an **optional** panel offers **Link wedding party** (sets `wedding_member_id` + party for Wedding Manager workflow sync). **Mark Attended** can still prompt to sync member flags only when a member link exists.
- Editing the visible name after selecting a Customer deliberately clears the stale Customer/member identity instead of silently keeping the wrong linkage.
- Duration and resource assignments are server validated. Cancellation is a status transition with a required reason; the row is not hard-deleted.
- An `expected_revision` blocks stale edits from another workstation. Staff must refresh before applying their change.

## Salesperson dropdown

The shared appointment modal loads **`GET /api/staff/list-for-pos`** (active staff only) and filters appointment choices to **`role === "salesperson"`** or **`role === "sales_support"`** (PostgreSQL enum `staff_role`, serialized as `salesperson` / `sales_support` in JSON). Staff assignment uses the same avatar mini-selector pattern as Register. Labels use **`full_name`**; new ROS bookings also store **`salesperson_staff_id`** while preserving the historical **`salesperson`** display string. Legacy name-only appointments still load, but duplicate staff names are not silently resolved.

If a selected salesperson is not scheduled for that date/time, normal save is blocked. A Manager Access override can be recorded with a required reason; the server audits the appointment, staff id/name, override reason, validation message, manager, and timestamp.

When Wedding Manager is embedded in ROS, appointment create/update/delete audit attribution uses the authenticated staff display name from the Back Office session. Staff should not see a separate "who is recording this?" identity picker in normal ROS use.

Form fields use the shared **`ui-input`** class so borders match the rest of ROS (`--app-input-border`).

## Client API helper

**`client/src/lib/weddingApi.ts`** (fetch-based):

- `searchCustomers(q, opts?)` — passes **`limit`/`offset`** to `/api/customers/search` when supplied
- `getAppointmentStaff()` / `getSalespeople()` — **salesperson** and **sales_support** staff for the appointment staff picker (aligned with **Staff → Schedule**; bookings are warned against **`staff_effective_working_day`** when the name matches roster schedule-eligible staff — see **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`**).
- `getAppointments` / `addAppointment` / `updateAppointment` — payloads use **snake_case** keys expected by the server (`wedding_member_id`, `customer_id`, `customer_display_name`, `starts_at`, `salesperson_staff_id`, duration/resource fields, and revision guards). List ranges are timezone-explicit and server-bounded.

## Notifications and timezone

Customer-facing confirmation, cancellation, and 24-hour reminder text is formatted in `reporting.effective_store_timezone()`. Email calendar attachments use the saved appointment end time. Delivery idempotency is per appointment, notification kind, channel, and current start time, so rescheduling produces a new current-time notification while an old delivery does not suppress it. Failed confirmation, reminder, and cancellation channels retry with bounded backoff. Appointments without a linked Customer remain visible operationally but do not receive automated customer messages.

## Search, history, and cross-module navigation

Appointment search indexes Customer names (including member-derived identity), one-off display names, phone, party, type, staff, status, and notes. Create, edit, cancellation, absence reassignment, and absence unassignment refresh appointment search and publish calendar update events. Universal Search, Operations Timeline, Customer history, notifications, and the Conflicts workspace open the exact appointment by ID. Cancelled appointments remain searchable and auditable.

Wedding Manager’s `api.js` maps the same fields for `addAppointment`.

## Party pipeline vs open appointments (embedded Wedding Manager)

**Party detail** may **block** marking **Measured** or **Fitting** complete when a **scheduled** appointment of that type is still **open** (not Attended / Missed / Cancelled). The client loads appointments in a **date window** around the party’s event date (plus a short in-memory cache) so the check stays fast; it does not download the entire calendar. Staff-facing summary: **`docs/staff/weddings-back-office.md`** (**Action Board** / **Parties**).

The Wedding Manager **Upcoming Appts** and **Missed Appts** dashboard cards only show appointments linked to a wedding party or wedding member. General store-calendar appointments remain in **Back Office → Appointments**.

## Related docs

- **`DEVELOPER.md`** — full migration table (current numbered files **00–97**), HTTP overview.
- **`docs/STAFF_SCHEDULE_AND_CALENDAR.md`** — operational staff calendar, **`staff_effective_working_day`**, **`/api/staff/schedule`**, morning dashboard **`today_floor_staff`** (migrations **57–58**, **064**).
- **`docs/REGISTER_DASHBOARD.md`** — POS **Dashboard** tab; **`GET /api/weddings/morning-compass`** and **`GET /api/weddings/activity-feed`** require staff headers + **`weddings.view`** (same wedding read RBAC family as **`/api/weddings/appointments`**).
- **`docs/SEARCH_AND_PAGINATION.md`** — Customer search/browse limits and inventory control-board (shared with POS/CRM).
- **`AGENTS.md`** — current migration file range, agent pointers.
