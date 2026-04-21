# Register (POS) dashboard

POS-Core surface for floor staff when a till session is open: **metrics, priority feed, notifications, wedding pulse, weather**, and a fast path to **Register (Cart)**. Admins continue to use **Back Office → Operations** ([`OperationalHome`](../client/src/components/operations/OperationalHome.tsx)) as their primary dashboard; this doc covers the **embedded POS** experience only.

## Navigation and default tab

- **Sidebar:** first rail item **Dashboard** (above **Register**) — [`PosSidebar`](../client/src/components/pos/PosSidebar.tsx), `PosTabId` includes `"dashboard"`.
- **Default on session open:** when `sessionId` is first set for an open drawer, [`PosShell`](../client/src/components/layout/PosShell.tsx) switches to **Dashboard** unless there is pending intent: **customer**, **order**, **inventory SKU**, or **wedding POS link** (those land on **Register**).
- **Register closed:** choosing **Dashboard** shows a short message to open the register.

## UI component

[`client/src/components/pos/RegisterDashboard.tsx`](../client/src/components/pos/RegisterDashboard.tsx)

Re-designed in v0.2.0 using the **WowDash** layout system (`DashboardStatsCard` and `DashboardGridCard`).

| Block | Source | Notes |
|-------|--------|-------|
| **Performance Stats** | `GET /api/staff/self/register-metrics` | Use `DashboardStatsCard` with sparklines and color signals. |
| **Priority Feed** | `MorningCompassQueue` ranker | Use `DashboardGridCard` framing; overdue pick/needs measure. |
| **Active Personnel** | `today_floor_staff` | Integrated status signals. |
| **Notifications** | Bell inbox sink | Short preview rows with immediate action labels. |

| Block | Source | Permission / role |
|-------|--------|-------------------|
| Headline | `staffDisplayName` (Authenticated) | **Staff Identity Priority (v0.2.1)**: Always reflects the persona who explicitly signed in, NOT the register opener. |
| Weather | `GET /api/weather/forecast` | Public (no RBAC) |
| **Attributed sales (store day)** | `GET /api/staff/self/register-metrics` | **Salesperson** and **sales_support** only (by `staffRole`); logs **`register_metrics_view`** in `staff_access_log` |
| Wedding pulse | `GET /api/weddings/morning-compass` | **`weddings.view`**; staff headers via **`mergedPosStaffHeaders`** |
| Tasks | `GET /api/tasks/me` | **`tasks.complete`** |
| Notifications | `GET /api/notifications` + read / complete / archive | **`notifications.view`**; **short** preview lines (**bundles** show a count + “open inbox” — full list expands in the bell drawer). **Open inbox** for the drawer. Automated kinds include backup alerts, integration health, **`task_due_soon_bundle`**, **`rms_r2s_charge`** (Sales Support: **submit** R2S after RMS / RMS90 **charge** tender — migration **68**). R2S **payment** collections use **Staff → Tasks** ad-hocs (**69**) — see **`docs/PLAN_NOTIFICATION_CENTER.md`**, **`docs/NOTIFICATION_GENERATORS_AND_OPS.md`**, and **`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`**. |

**Client context:** [`BackofficeAuthContext`](../client/src/context/BackofficeAuthContext.tsx) exposes **`staffRole`** (`admin` \| `salesperson` \| `sales_support` \| `null`) from **`GET /api/staff/effective-permissions`** (`role` field). Authorization remains **server-side** on every API.

### Weather fallback visibility

When the weather service falls back to mock data, the dashboard shows a visible **Mock Weather** badge and short note so floor staff know the forecast is degraded but still safe to view.

## Server: register metrics

- **Logic:** [`server/src/logic/register_staff_metrics.rs`](../server/src/logic/register_staff_metrics.rs)
- **Route:** `GET /api/staff/self/register-metrics` — [`server/src/api/staff.rs`](../server/src/api/staff.rs) (requires **`require_authenticated_staff_headers`**)

**Semantics:** Store **calendar date** from `store_settings.receipt_config.timezone` (fallback **`America/New_York`**). Counts **`order_items`** where **`salesperson_id`** = caller on orders that had **any payment** on that local date (distinct orders via payment allocations). Returns **`line_count`**, **`attributed_gross`** (string decimal), **`store_date`**, **`timezone`**.

## Wedding API auth (morning board)

These routes require **staff headers** and **`weddings.view`** (same as other wedding reads):

- `GET /api/weddings/morning-compass`
- `GET /api/weddings/activity-feed`

**Back Office Operations** ([`OperationalHome`](../client/src/components/operations/OperationalHome.tsx)) only fetches them when **`hasPermission("weddings.view")`** to avoid **403** noise and to show a clear message on **Morning Dashboard** (activity feed and wedding blocks) when the permission is missing.

The **embedded Wedding Manager** ([`WeddingManagerAuthBridge`](../client/src/components/wedding-manager/WeddingManagerAuthBridge.tsx)) registers staff headers for [`wedding-manager/lib/api.js`](../client/src/components/wedding-manager/lib/api.js) fetches.

## Notifications: user dismiss

- **API:** `POST /api/notifications/{staff_notification_id}/archive` — sets **`archived_at`**, **`compact_summary`**, appends **`staff_notification_action`** with action **`archived`**.
- **UI:** **Dismiss** in notification drawer (**Inbox** tab) and on Register dashboard preview rows.

System retention jobs still archive stale rows by age; user dismiss is immediate inbox hide with audit.

## Predictive Priority Feed (Morning Compass)

**Suggested next** (register default tab): ranked queue from wedding compass queues (overdue pickup → needs order → needs measure), **open tasks** (due / overdue weighting), and **notification** preview (critical kinds boosted). Managed via **`DashboardGridCard`** layout. Tapping a wedding row opens **[`CompassMemberDetailDrawer`](../client/src/components/operations/CompassMemberDetailDrawer.tsx)**; **Open full party** exits POS to the wedding workspace. Tasks open **`TaskChecklistDrawer`**; notifications open the bell inbox. Rules live in **[`client/src/lib/morningCompassQueue.ts`](../client/src/lib/morningCompassQueue.ts)** (client-side ranker; no ML). Operations **Operations Hub** uses the same queue with a wider limit. Product note: **[`docs/PLAN_MORNING_COMPASS_PREDICTIVE.md`](./PLAN_MORNING_COMPASS_PREDICTIVE.md)**.

## Related docs

- **[`docs/STAFF_PERMISSIONS.md`](./STAFF_PERMISSIONS.md)** — RBAC keys (`weddings.view`, `notifications.view`, `tasks.complete`).
- **[`docs/TILL_GROUP_AND_REGISTER_OPEN.md`](./TILL_GROUP_AND_REGISTER_OPEN.md)** — Multi-lane till, combined Z-close.
- **[`docs/PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md)** — inbox, read/complete/archive, generators.
- **[`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`](./STAFF_TASKS_AND_REGISTER_SHIFT.md)** — `/api/tasks/me`, POS Tasks tab.
- **[`docs/STAFF_SCHEDULE_AND_CALENDAR.md`](./STAFF_SCHEDULE_AND_CALENDAR.md)** — **`today_floor_staff`** on morning compass.
- **[`docs/PLAN_MORNING_COMPASS_PREDICTIVE.md`](./PLAN_MORNING_COMPASS_PREDICTIVE.md)** — Action-first queue / prioritization (planning).
- **[`docs/POS_PARKED_SALES_AND_RMS_CHARGES.md`](./POS_PARKED_SALES_AND_RMS_CHARGES.md)** — Parked cart API, Z-close purge, R2S **charge** vs **payment** ledger, inbox notifications, payment **tasks**.
