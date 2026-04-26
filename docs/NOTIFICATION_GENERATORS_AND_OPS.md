# Notification generators and operations

Status: **Canonical notification operations reference** for migrations, env vars, code paths, bundled payloads, and deep-link behavior. For the broader messaging and notification map, start with [CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md](./CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md).

Short ops and developer reference for **automated inbox items** beyond the narrative in [`PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md). Use that plan for architecture, RBAC, and UI; use this file for **migrations**, **env vars**, and **where code lives**.

## Migrations

| Migration | Objects | Role |
|-----------|---------|------|
| **51–52**, **56** | `app_notification`, digest ledger, `task_due_soon`, etc. | Core inbox + morning digest + task reminders |
| **60** [`60_store_backup_health.sql`](../migrations/60_store_backup_health.sql) | `store_backup_health` | Timestamps for local/cloud backup outcomes → admin **`backup_admin_*`** notifications |
| **61** [`61_notification_integration_extras.sql`](../migrations/61_notification_integration_extras.sql) | `integration_alert_state`, `staff_auth_failure_event` | QBO token refresh + weather finalize health rows; PIN mismatch audit for **`pin_failure_digest`** |
| **68** [`68_pos_parked_and_rms_charge_audit.sql`](../migrations/68_pos_parked_and_rms_charge_audit.sql) | `pos_parked_sale`, `pos_parked_sale_audit`, `pos_rms_charge_record` | Checkout-driven **`rms_r2s_charge`** fan-out to **sales_support** after RMS / RMS90 tender — **[`POS_PARKED_SALES_AND_RMS_CHARGES.md`](./POS_PARKED_SALES_AND_RMS_CHARGES.md)** |
| **69** [`69_rms_charge_payment_line.sql`](../migrations/69_rms_charge_payment_line.sql) | `products.pos_line_kind`, `pos_rms_charge_record.record_kind`, nullable `task_instance.assignment_id` | R2S **payment** checkout creates ad-hoc **Sales Support** **tasks** (not the same as **`rms_r2s_charge`** notifications) — **[`POS_PARKED_SALES_AND_RMS_CHARGES.md`](./POS_PARKED_SALES_AND_RMS_CHARGES.md)** |

Apply with `./scripts/apply-migrations-docker.sh`; drift check with `./scripts/migration-status-docker.sh` (probes in `scripts/ros_migration_build_probes.sql` through the latest numbered migration; current repo ceiling is tracked in **`DEVELOPER.md`**).

## Environment variables (server)

| Variable | Default | Notes |
|----------|---------|--------|
| `RIVERSIDE_MORNING_DIGEST_HOUR_LOCAL` | `7` | Store-local hour (0–23) after which the **once-per-day** admin digest may run (`ReceiptConfig.timezone`). |
| `RIVERSIDE_BACKUP_OVERDUE_HOURS` | `30` | If local backup is not in a failure state but **last success** is older than this, **`backup_admin_past_due`** (max **720**). |
| `RIVERSIDE_PIN_FAILURE_DIGEST_THRESHOLD` | `5` | Failed PIN rows in the last rolling hour (see **`staff_auth_failure_event`**) before admins get **`pin_failure_digest`** (max **1000**). |
| `RIVERSIDE_NOTIFICATION_ARCHIVE_HOURS` | `720` | Age before inbox rows are archived (~30 days). |
| `RIVERSIDE_NOTIFICATION_PURGE_HOURS` | `9600` | Purge archived rows older than this (~400 days). |
| `COUNTERPOINT_SYNC_TOKEN` | unset | When set, **stale** Counterpoint sync notifications use a **72h** “no successful `last_ok_at`” rule; bridge errors use `counterpoint_sync_runs.last_error`. |

Never log sync tokens or API keys.

## Code map

| Area | Location |
|------|----------|
| Hourly / scheduled generators | `server/src/logic/notifications_jobs.rs` (`run_notification_generators`, maintenance) — **bundled** kinds (`*_bundle`) upsert one **`app_notification`** per store-local day (or per assignee+day for **`task_due_soon_bundle`**) |
| Emitters + audience helpers | `server/src/logic/notifications.rs` — **`upsert_app_notification_by_dedupe`**, **`delete_app_notification_by_dedupe`**, incl. **`rms_r2s_charge`** from checkout (migration **68**) |
| Integration success/failure + PIN audit rows | `server/src/logic/integration_alerts.rs`; PIN insert on mismatch in `server/src/auth/pins.rs` |
| HTTP API (list, read, archive, broadcast) | `server/src/api/notifications.rs` |
| Client bell + drawer + deep links | `client/src/context/NotificationCenterContext.tsx`, `client/src/components/notifications/*`, `client/src/App.tsx` (`handleNotificationNavigate`), **`client/src/lib/notificationBundle.ts`** (parse **`notification_bundle`** + legacy rows), **`client/src/lib/notificationDeepLink.ts`** (routable vs expand-only) |

## Bundled payloads (`notification_bundle`)

Many hourly generators set **`app_notification.deep_link.type`** = **`notification_bundle`** with **`bundle_kind`**, **`items`**: array of **`{ title, subtitle?, deep_link }`**. The inbox shows one compact row; expanding lists items; each nested **`deep_link`** is passed to **`handleNotificationNavigate`** (e.g. **`inventory`** + **`product_id`**, **`staff_tasks`** + **`instance_id`**, **`purchase_order`**, **`wedding_party`**, …). Morning digest blocks use **`morning_*_bundle`** kinds. See **[`PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md)** for the full kind catalog.

## Deep links (client)

Notification `deep_link.type` values handled in Back Office include **`order`**, **`notification_bundle`** (expand then navigate per item), **`settings`** (`section`: `backups`, `general`, `profile`, …), **`inventory`**, **`qbo`** / **`qbo_staging`**, **`dashboard`** (`subsection` e.g. `payouts`), **`register`**, **`customers`**, **`appointments`**, **`staff`**, **`staff_tasks`** (`instance_id` → Staff → Tasks checklist drawer), **`gift-cards`**, **`wedding_party`**, **`alteration`**, **`purchase_order`**. Extend `handleNotificationNavigate` when adding new generator kinds.

## Related docs

- [`PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md) — product/architecture checklist and `kind` catalog  
- [`DEVELOPER.md`](../DEVELOPER.md) — env table + migrations reference table  
- [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md) — backup behavior and **`store_backup_health`**  
