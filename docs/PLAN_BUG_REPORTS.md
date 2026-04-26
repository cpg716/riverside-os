# PLAN: Staff bug reports (in-app)

**Status:** **Completed (shipped)** — migrations **101**–**103** (triage + retention + correlation id), API + Settings + notifications + optional Sentry.

## Goal

Let any **authenticated staff** submit a bug report from the running app with a **screenshot**, **summary**, **repro steps**, and **client diagnostics** (console log + build metadata). **Settings admins** (`settings.admin`) triage submissions under **Settings → Bug reports** (list, detail, mark complete, export PNG/JSON).

## Completed deliverables

- [x] **Schema** — `staff_bug_report` table, `bug_report_status` enum (`pending` | `complete` | `dismissed`); indexes on `created_at`, `status` — **`migrations/101_staff_bug_reports.sql`**, **`103_staff_bug_report_triage.sql`** (adds `dismissed`, **`correlation_id`**, **`resolver_notes`**, **`external_url`**)
- [x] **Schema** — `staff_bug_report.server_log_snapshot` TEXT (recent in-process API **`tracing`** output at submit time, capped) — **`migrations/102_bug_report_server_log_snapshot.sql`**
- [x] **Observability** — `ServerLogRing` / `ServerLogRingLayer` (`server/src/observability/server_log_ring.rs`) wired in `main.rs` via **`init_tracing_with_optional_otel`** (optional **OpenTelemetry OTLP** layer + **fmt** + ring); snapshot copied into each bug report (not a full host log file or other replicas) — **[`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)**
- [x] **Submit API** — `POST /api/bug-reports` — `require_authenticated_staff_headers`; validates body sizes and PNG magic; persists `correlation_id` (response JSON + **`X-Bug-Report-Correlation-Id`** header), `include_screenshot`, `screenshot_png` BYTEA, `client_console_log`, `client_meta` JSONB (incl. **`ros_navigation`**: tab, subsection, register session, shell flags), `server_log_snapshot`; per-staff rate limit; notifies **`settings.admin`** via **`app_notification`** (`kind`: `staff_bug_report`, deep link **Settings → Bug reports**)
- [x] **Admin API** — merged under **`/api/settings`**: `GET /api/settings/bug-reports`, `GET`/`PATCH /api/settings/bug-reports/{id}` — **`settings.admin`**; PATCH accepts optional **`status`**, **`resolver_notes`**, **`external_url`**
- [x] **Server modules** — `server/src/api/bug_reports.rs`, `server/src/logic/bug_reports.rs`; `settings::router().merge(bug_reports::settings_subrouter())` + `nest("/api/bug-reports", …)` in **`server/src/api/mod.rs`**
- [x] **Client capture** — **`BugReportFlow`** (`html2canvas` on `#root` when “Attach screenshot” is checked; otherwise placeholder PNG), optional **`VITE_SENTRY_DSN`** (`@sentry/react` in **`main.tsx`**); **`mergedPosStaffHeaders`** for `fetch`
- [x] **Chrome** — Bug icon in **`Header`** and **`PosShell`**; **`App.tsx`** holds `bugReportOpen` + passes **`onOpenBugReport`**
- [x] **Settings** — **`BugReportsSettingsPanel`**, subsection **`bug-reports`** in **`sidebarSections.ts`**; gated by **`settings.admin`** (**`SIDEBAR_SUB_SECTION_PERMISSION`** `settings:bug-reports`)
- [x] **Retention** — daily cron (04:00 server local) in **`start_backup_worker`** (`main.rs`): **`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`** (default **365**, minimum **30**)
- [x] **Probes** — **`scripts/ros_migration_build_probes.sql`** includes **101**–**103**

## API summary

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/bug-reports` | Authenticated staff (BO headers; merged POS+staff when applicable) |
| GET | `/api/settings/bug-reports` | `settings.admin` |
| GET | `/api/settings/bug-reports/{id}` | `settings.admin` |
| PATCH | `/api/settings/bug-reports/{id}` | `settings.admin` (body: any of `status` `pending` \| `complete` \| `dismissed`, `resolver_notes`, `external_url`) |

## Privacy and retention

- Submissions may include **PII visible on screen** in the screenshot and in console logs. Treat the **`staff_bug_report`** table as **internal ops data**; restrict via DB access and **`settings.admin`** only.
- **Retention:** server deletes rows older than **`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`** (see **`main.rs`** backup scheduler).

## File map

| Area | Path |
|------|------|
| Migrations | `migrations/101_staff_bug_reports.sql`, `102_bug_report_server_log_snapshot.sql`, `103_staff_bug_report_triage.sql` |
| API + handlers | `server/src/api/bug_reports.rs` |
| Queries | `server/src/logic/bug_reports.rs` |
| Server log ring | `server/src/observability/server_log_ring.rs`, `server/src/observability/mod.rs`; subscriber wiring in **`server/src/main.rs`** |
| Submit + modal | `client/src/components/bug-report/BugReportFlow.tsx` |
| Admin panel | `client/src/components/settings/BugReportsSettingsPanel.tsx` |
| Settings wiring | `client/src/components/settings/SettingsWorkspace.tsx` |
| Router/CORS | `client/src/App.tsx`, `client/src/components/layout/GlobalTopBar.tsx`, `client/src/components/layout/PosShell.tsx` |
| RBAC map | `client/src/context/BackofficeAuthContext.tsx` (`settings:bug-reports`) |
| Sidebar | `client/src/components/layout/sidebarSections.ts` |

## Related

- **Staff manuals:** [`docs/staff/bug-reports-submit-manual.md`](staff/bug-reports-submit-manual.md) (how to report), [`docs/staff/bug-reports-admin-manual.md`](staff/bug-reports-admin-manual.md) (admin triage).
- **Server tracing + OTLP:** [`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md) — how **`ServerLogRing`** fits the subscriber stack vs optional OpenTelemetry export.
- **Migrations script:** `./scripts/apply-migrations-docker.sh` uses a numeric-friendly glob and **`sort -V`** so **`100+`** files apply after **99** — see repo `scripts/`.
- **Reviews policy** (separate feature): migration **100** `store_settings.review_policy`; not part of this plan.
