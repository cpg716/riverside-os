# Plan: App-wide Notification Center (Riverside OS)

Version-controlled implementation plan for a **PostgreSQL-backed** notification system: per-staff read/completed state, audit logging, **bell + slideout** (`DetailDrawer`) on **Back Office**, **POS (`PosShell`)**, and **Wedding** shells, **admin broadcast** with audience targeting, **retention** (archive after 30 days, browse history up to 1 year), **system event generators** (orders, weddings, pickup, alterations, QBO, procurement/PO), and **shared wiring** with Podium messaging per **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)** ( **`read-all`**, **`messaging_unread_nudge`** ).

**Related:** **Cross-cutting tracker** — [`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md). Podium env + webhook deep spec — [`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md). **Ops quick reference** (migrations **60–61**, env vars, code paths, deep links): [`NOTIFICATION_GENERATORS_AND_OPS.md`](./NOTIFICATION_GENERATORS_AND_OPS.md).

## Implementation checklist

- [x] **Schema:** `app_notification`, `staff_notification`, `staff_notification_action` (+ indexes, `dedupe_key`, retention columns) — **`migrations/51_app_notifications.sql`**; catalog flags + digest ledger — **`migrations/52_track_low_stock_morning_digest.sql`**
- [x] **Server:** `server/src/logic/notifications.rs` + `server/src/api/notifications.rs` (list, unread-count, read, complete, **archive** / user dismiss, broadcast, fan-out); register router; permission seeds
- [x] **Retention job:** archive at 30d (hours via **`RIVERSIDE_NOTIFICATION_ARCHIVE_HOURS`**), history via **`include_archived`**, purge via **`RIVERSIDE_NOTIFICATION_PURGE_HOURS`**
- [x] **Client:** `NotificationCenterContext` + drawer + bell; mount in `Header`, `PosShell`, `WeddingShell`; deep-link navigation from `App` (**`handleNotificationNavigate`**). **Compact inbox:** list shows kind + title only; **admin broadcast** expands for full body + sender; **`notification_bundle`** rows expand to a scrollable list (each line navigates via its nested `deep_link`); other routable notifications **tap once** to open the target workspace (**`notificationBundle.ts`**, **`notificationDeepLink.ts`**). Task reminders from bundles use **`staff_tasks`** + **`instance_id`** → Staff → Tasks checklist drawer.
- [x] **Broadcast UI:** composer in drawer for **`notifications.broadcast`** (all staff, admins only); full custom staff-ID audience available on API (`audience.mode` = `staff_ids`)
- [x] **Generators (hourly):** **Bundled** high-volume sweeps (`*_bundle` **`app_notification.kind`**, **`notification_bundle`** `deep_link`, **`upsert_app_notification_by_dedupe`**) replace legacy one-row-per-entity kinds (those rows are **`DELETE`d** on sweep): **`wedding_soon_bundle`**, **`order_due_stale_bundle`**, **`pickup_stale_bundle`** (open, balance cleared, unfulfilled lines 7+d), **`alteration_due_bundle`**, six **`po_*_bundle`** rules (overdue standard + direct_invoice, unlabeled, partial stale, draft stale, submitted missing expected_at), **`task_due_soon_bundle`** (per assignee + store-local day; open instances with **`due_date`** today or tomorrow — migration **56**, `run_task_due_reminders`), **`integration_health_failed_bundle`**, **`counterpoint_alerts_bundle`** (when **`COUNTERPOINT_SYNC_TOKEN`** is set), **`appointment_soon_bundle`**, **`negative_available_stock_bundle`**, **`gift_card_expiring_soon_bundle`**, **`special_order_ready_to_stage_bundle`**. **Unbundled / digest-style:** **`qbo_sync_failed`** (event-driven + hourly sweep), **`pin_failure_digest`**, **`after_hours_access_digest`**. **Backup health** (admin-only): **`backup_admin_local_failed`**, **`backup_admin_cloud_failed`**, **`backup_admin_past_due`** — migration **`60`**, `run_backup_admin_notifications`; deep link **`settings` → `backups`**. Migration **`61`**: **`integration_alert_state`** + **`staff_auth_failure_event`**. Event-driven emitters in `notifications.rs`: register cash discrepancy, catalog import rows skipped, customer merge, order fully fulfilled, commission finalize failed — **`handleNotificationNavigate`** in `App.tsx`. **Checkout (migration 68):** **`on_account_rms`** / **`on_account_rms90`** → **`rms_r2s_charge`** fan-out — **[`POS_PARKED_SALES_AND_RMS_CHARGES.md`](./POS_PARKED_SALES_AND_RMS_CHARGES.md)**.
- [x] **Admin morning digest** (once per **store-local** calendar day, after configurable hour): **bundled** **`morning_low_stock_bundle`**, **`morning_wedding_today_bundle`**, **`morning_po_expected_bundle`**, **`morning_alteration_due_bundle`** (each is one inbox row with **`notification_bundle`** payload + per-item `deep_link`s), plus a single **`morning_refund_queue`** summary row. Low-stock eligibility unchanged: template + variant **`track_low_stock`**, **`reorder_point > 0`**, available = `stock_on_hand - reserved_stock` ≤ reorder. Ledger: **`morning_digest_ledger`** + timezone from **`ReceiptConfig.timezone`**; env **`RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL`** (default **7**). Migration **`52_track_low_stock_morning_digest.sql`**. Legacy per-entity kinds (`morning_low_stock`, etc.) are **deleted** when the bundled job runs.
- [x] **Podium + inbox:** **71** webhook ledger; **99**+ **`podium_inbound`** → **`podium_sms_inbound`** / **`podium_email_inbound`** + CRM threads, fan-out to staff, **`read-all`**, **18h nudge** (ingest off with **`RIVERSIDE_PODIUM_INBOUND_DISABLED`**) — **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)**. **`GET /api/notifications`** supports **`kinds`** for filtered views.
- [x] **Docs:** `DEVELOPER.md`, `docs/STAFF_PERMISSIONS.md`, `AGENTS.md` file map

---

## Current state

- **Shipped:** bell + [`DetailDrawer`](../client/src/components/layout/DetailDrawer.tsx) on Back Office ([`Header.tsx`](../client/src/components/layout/Header.tsx) in `AppMainColumn`), [`PosShell.tsx`](../client/src/components/layout/PosShell.tsx), [`WeddingShell.tsx`](../client/src/components/layout/WeddingShell.tsx); provider [`NotificationCenterContext.tsx`](../client/src/context/NotificationCenterContext.tsx).
- **Staff identity**: [`BackofficeAuthContext`](../client/src/context/BackofficeAuthContext.tsx) + headers; POS has `cashierCode` / session; [`staff`](../migrations/01_initial_schema.sql) + [`staff_role`](../migrations/17_staff_authority.sql) (`admin` | `salesperson` | `sales_support`).
- **Audit precedent**: [`staff_access_log`](../migrations/17_staff_authority.sql) + [`log_staff_access`](../server/src/auth/pins.rs).
- **Deep links precedent**: `ordersDeepLinkOrderId` + `setActiveTab("orders")` in `App.tsx`; `navigateWedding(partyId)` / `pendingWmPartyId`.

## Architecture (data)

**Core idea:** one canonical **notification** row (what happened + payload for navigation), many **per-staff rows** (inbox + state), append-only **action log** (who read/completed).

```mermaid
erDiagram
  app_notification ||--o{ staff_notification : fans_out
  staff_notification ||--o{ staff_notification_action : audited
  app_notification {
    uuid id PK
    timestamptz created_at
    text kind
    text title
    text body
    jsonb deep_link
    text source
    jsonb audience_json
  }
  staff_notification {
    uuid id PK
    uuid notification_id FK
    uuid staff_id FK
    timestamptz read_at
    timestamptz completed_at
    timestamptz archived_at
    text compact_summary
  }
  staff_notification_action {
    uuid id PK
    uuid staff_notification_id FK
    uuid actor_staff_id FK
    text action
    timestamptz created_at
    jsonb metadata
  }
```

- **`app_notification`**: `kind` includes **event-driven / single-row** emitters (e.g. `admin_broadcast`, `qbo_sync_failed`, `rms_r2s_charge`, `register_cash_discrepancy`, …) and **bundled** hourly/morning kinds with suffix **`_bundle`** (e.g. **`morning_low_stock_bundle`**, **`wedding_soon_bundle`**, **`order_due_stale_bundle`**, **`task_due_soon_bundle`**, **`negative_available_stock_bundle`**, **`counterpoint_alerts_bundle`**, six **`po_*_bundle`** rules, …). **`morning_refund_queue`**, **`pin_failure_digest`**, **`after_hours_access_digest`**, and **backup admin** kinds stay **one row per signal** where appropriate. **Legacy** per-entity kinds (`morning_low_stock`, `order_due`, `appointment_soon`, …) are no longer inserted; generators **`DELETE`** those rows when the bundled job runs so old inboxes collapse after the next hourly pass.
- **`deep_link`:** Routable shapes include `order`, `wedding_party`, `alteration`, `purchase_order`, `qbo_staging`, **`qbo`** + `section`, `inventory` + optional `product_id`, **`settings`** + **`section`** (`backups`, `general`, `profile`), **`dashboard`** + `subsection`, **`register`**, **`customers`**, **`appointments`**, **`staff`**, **`staff_tasks`** + **`instance_id`** (checklist drawer), **`gift-cards`**, and **`notification_bundle`** (`bundle_kind`, **`items`**: `{ title, subtitle, deep_link }` per row). **`upsert_app_notification_by_dedupe`** refreshes title/body/`deep_link` for the same **`dedupe_key`** (store-local day or assignee+day for tasks).
- **`staff_notification`**: one row per (notification × staff). `read_at` / `completed_at` / user **`archived_at`** logged via **`staff_notification_action`** (`read`, `completed`, **`archived`** for **Dismiss**).
- **Retention:** archive `staff_notification` after **30 days** (e.g. set `archived_at`, compact body); default list API excludes archived; **history** includes archived for **365 days**; purge older per policy.

**Audience model:** `audience_json` e.g. `{ "mode": "roles", "roles": ["admin"] }`, `all_staff`, `staff_ids`, `permission` key, or salesperson-scoped linkage for “only their” rows. Fan-out creates **N** `staff_notification` rows; **`dedupe_key`** prevents duplicate fan-out.

**RBAC** (new seeds + [`permissions.rs`](../server/src/auth/permissions.rs)):

- `notifications.view` — inbox read/complete (default for active staff / BO auth as product chooses).
- `notifications.broadcast` — broadcast composer (often admin-only; may alias `settings.admin` for v1).
- **`procurement.view`** (existing) — gate PO notification fan-out if not admin-only.

## Architecture (API)

New [`server/src/api/notifications.rs`](../server/src/api/notifications.rs) (register in [`mod.rs`](../server/src/api/mod.rs)):

| Endpoint | Purpose |
|----------|---------|
| `GET /api/notifications` | Inbox (+ optional `include_archived`, `kinds`) |
| `GET /api/notifications/unread-count` | Bell / SMS badge |
| `POST /api/notifications/{staff_notification_id}/read` | Set `read_at` + action log |
| `POST /api/notifications/{staff_notification_id}/complete` | Set `completed_at` (+ `read_at` if null) + action log |
| `POST /api/notifications/{staff_notification_id}/archive` | User **Dismiss**: set `archived_at` + compact summary + action log **`archived`** |
| `POST /api/notifications/broadcast` | Admin broadcast + fan-out |

Logic: [`server/src/logic/notifications.rs`](../server/src/logic/notifications.rs) — insert + dedupe, **`upsert_app_notification_by_dedupe`** (bundles), **`delete_app_notification_by_dedupe`**, audience helpers, archive/purge, event emitters. Middleware: existing staff headers ([`middleware/mod.rs`](../server/src/middleware/mod.rs)).

## Architecture (client)

- **`NotificationCenterProvider`** ([`client/src/context/NotificationCenterContext.tsx`](../client/src/context/NotificationCenterContext.tsx) — new): unread count, refresh, open/close, mark read/complete, navigate callback from `App`.
- **`NotificationCenterBell`** + **`NotificationCenterDrawer`** (wraps `DetailDrawer`): Inbox / History; **compact** rows (kind + title); **broadcast** tap expands full message; **bundle** tap expands item list; routable single-row tap → navigate (**`notificationDeepLink.ts`**). **Inbox** **Dismiss** → **`POST /.../archive`**. **[`RegisterDashboard`](../client/src/components/pos/RegisterDashboard.tsx)** — short preview (“N items — open inbox to expand” for bundles) + Read / Complete / Dismiss.
- **`BroadcastComposer`**: when `notifications.broadcast` (or admin).

**Mount points:** [`Header.tsx`](../client/src/components/layout/Header.tsx), [`PosShell.tsx`](../client/src/components/layout/PosShell.tsx), [`WeddingShell.tsx`](../client/src/components/layout/WeddingShell.tsx).

**Navigation contract:** `handleNotificationNavigate` in [`App.tsx`](../client/src/App.tsx) — tab switch, wedding mode, POS mode, `ordersDeepLinkOrderId`, `pendingWmPartyId`, **alterations**, **PO / procurement**, **QBO staging**, **settings** (`profile` / `general` / `backups`), **inventory list + product hub**, **`staff_tasks`** + **`instance_id`** (Staff → Tasks drawer via **`StaffTasksPanel`** props through **`AppMainColumn`** / **`StaffWorkspace`**).

## System event generators (phased)

Jobs in [`server/src/logic/notifications_jobs.rs`](../server/src/logic/notifications_jobs.rs): **hourly** tokio interval in [`main.rs`](../server/src/main.rs) (archive/purge + generators below) + **event-driven** hooks where appropriate (e.g. QBO failure immediately after `qbo_sync_logs` → `failed`).

### Admin morning digest (**admin** staff only)

Runs on the **first hourly tick** on or after **`RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL`** (0–23, default **7**) in the store’s **`ReceiptConfig.timezone`**. Inserts one row into **`morning_digest_ledger`** for that **local calendar date** (`ON CONFLICT DO NOTHING`); if the day was already claimed, the whole morning block is skipped.

| Kind | Dedupe (per store-local day) | Payload |
|------|------------------------------|---------|
| `morning_low_stock_bundle` | `morning_low_stock_bundle:{yyyy-mm-dd}` | **`notification_bundle`** / `bundle_kind` **`morning_low_stock`**; each **`items[]`** row: `inventory` + `product_id` |
| `morning_wedding_today_bundle` | `morning_wedding_today_bundle:{date}` | **`notification_bundle`**; items → `wedding_party` |
| `morning_po_expected_bundle` | `morning_po_expected_bundle:{date}` | **`notification_bundle`**; items → `purchase_order` |
| `morning_alteration_due_bundle` | `morning_alteration_due_bundle:{date}` | **`notification_bundle`**; items → `alteration` |
| `morning_refund_queue` | `morning_refund_queue:{date}` | Single row: `orders` + `subsection=open` (not bundled) |

**Low stock eligibility:** `products.track_low_stock` **and** `product_variants.track_low_stock` (both default **false**; toggled in **Product hub** General + Matrix in Back Office), `reorder_point > 0`, available ≤ reorder.

**Catalog:** migration **`52_track_low_stock_morning_digest.sql`** (`products.track_low_stock`, `product_variants.track_low_stock`, `morning_digest_ledger`). API: `PATCH /api/products/{id}/model`, `PATCH /api/products/variants/{id}/pricing` with `track_low_stock`; create product body optional `track_low_stock`.

### Core retail / operations

| Rule | Audience | Data |
|------|----------|------|
| Wedding soon (e.g. ≤14d) | Admin: all; Salesperson: attributed parties | `wedding_parties.event_date` |
| Orders coming due | Admin + role-wide; Salesperson: `order_items.salesperson_id` | `orders` / lines (define “due”) |
| Pickup ready 7+d, not picked up | Admin + cashier-facing roles | **Gap:** add `orders.pickup_ready_at` or line-level signal |

### Alteration due

| Rule | Audience | Data |
|------|----------|------|
| Due soon / overdue | Admin + cashier-facing: all open due; Salesperson: customers attributed via `linked_order_id` → order lines | `alteration_orders.due_at`, status `intake` / `in_work` |

Deep link: `alteration` + `alteration_id`. **Hourly bundle:** kind **`alteration_due_bundle`**, dedupe **`alteration_due_bundle:{yyyy-mm-dd}`**, **`notification_bundle`** with per-alteration items (legacy **`alteration_due`** rows deleted on sweep).

### QBO sync failures (admin)

Event-driven after [`qbo.rs`](../server/src/api/qbo.rs) sets `qbo_sync_logs.status = failed`; optional nightly sweep. Dedupe: `qbo_failed:{sync_log_id}`. Deep link: `qbo_staging` + `sync_log_id`.

### Procurement / PO (admin-first)

Sources: [`purchase_orders`](../migrations/01_initial_schema.sql), lines, [`receiving_events`](../migrations/01_initial_schema.sql), [`product_variants.shelf_labeled_at`](../migrations/12_shelf_label_tracking.sql), [`inventory_transactions`](../migrations/01_initial_schema.sql).

| Bundle kind (per store-local day) | Rule summary |
|-----------------------------------|--------------|
| `po_overdue_receive_bundle` | Standard PO: `expected_at` + 3d, not fully received; excludes closed/cancelled/draft |
| `po_direct_invoice_overdue_bundle` | `direct_invoice` branch, same overdue heuristic |
| `po_received_unlabeled_bundle` | Recent receipts with unlabeled SKUs |
| `po_partial_receive_stale_bundle` | Partially received, idle 14+ days |
| `po_draft_stale_bundle` | Draft older than 21 days |
| `po_submitted_no_expected_date_bundle` | Submitted 7+ days without `expected_at` |

Each upserts one row; **`items[]`** carry `purchase_order` + `po_id`. Legacy per-PO kinds are removed on sweep. **`po_submitted_no_expected_date_bundle`** rows use dedupe key prefix **`po_submitted_no_expected_bundle`** (historic naming).

**Other hourly bundles (same pattern):** `wedding_soon_bundle`, `order_due_stale_bundle`, `pickup_stale_bundle`, `appointment_soon_bundle`, `integration_health_failed_bundle`, `counterpoint_alerts_bundle`, `gift_card_expiring_soon_bundle`, `special_order_ready_to_stage_bundle`, `negative_available_stock_bundle`. **Tasks:** `task_due_soon_bundle:{assignee_staff_id}:{yyyy-mm-dd}` — prior day’s assignee bundles for that date are deleted then recreated.

### Backlog

Additional “due today” signals (e.g. explicit order promise dates) if added to schema later.

## Integration with Podium SMS

See **[`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md)**. Inbound SMS creates `app_notification` (`sms_inbound` / `podium_sms`) + same fan-out; **SMS Module** list and **Notification Center** use the **same API** and badge counts; read/complete/audit identical. Optional later: mirror outbound automated SMS as low-priority staff notifications.

## Implementation order

1. Migration (tables, indexes, `dedupe_key`).
2. Rust: models, logic, API, optional `RIVERSIDE_NOTIFICATION_ARCHIVE_HOURS`.
3. Client: provider, drawer, bell; wire all shells.
4. Broadcast API + UI.
5. Generators (pickup timestamp schema if needed; alteration; QBO hook; PO SQL validated against receive code).
6. Podium webhooks: emit notifications; document `kinds` filter.
7. Update `DEVELOPER.md`, `STAFF_PERMISSIONS.md`, `AGENTS.md`; keep Podium plan cross-linked to this doc.

## Risks / decisions

- **Cashier-facing** = `salesperson` + `sales_support` (+ optional `admin`) unless a dedicated flag is added.
- **Read vs completed** per `kind` metadata.
- **POS auth** for `GET /api/notifications` must match how `PosShell` sends headers today.
- **QBO:** shared `dedupe_key` for event + sweep.
- **PO:** `direct_invoice` semantics vs standard receive.
- **Bundling:** high-volume hourly jobs **upsert** a single **`app_notification`** per store-local day (or per assignee+day for tasks) via **`dedupe_key`**; legacy per-entity rows are **deleted** when the bundled job runs. Client inbox stays compact; users expand bundles or tap through to targets.
