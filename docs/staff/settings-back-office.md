# Settings (Back Office)

**Audience:** Store admins.

**Where in ROS:** Back Office → **Settings**. The settings workspace initializes to your **Staff Profile** by default. Settings are ordered into practical neighborhoods: profile and store setup, register hardware, maintenance, integrations, then help/system tools.

**Related permissions:** **settings.admin** for most store-wide configuration. **Staff access defaults** is visible with **settings.admin** **or** **staff.manage_access** (role permission templates + template discount caps). **Online store** uses **online_store.manage** (admins also have access via **settings.admin** on the same APIs). **Profile** / **avatar** may be self-service for any signed-in staff.

---

## How to use this area

**Profile** changes **you**. **General** changes **the store** (theme, **store staff playbook**, build info). **Online store** covers **marketing pages** for the public **`/shop`** site and **web coupons** — see **§ Online store** below. **Printers & Scanners**, **Receipt Settings**, **Tag Designer**, and **Terminal Overrides** stay together for register setup. **Integrations** holds third-party bridges such as **Podium**, **Shippo**, **Stripe**, **QuickBooks**, **Counterpoint**, **NuORDER**, Weather, Insights, and Meilisearch. **Help Center**, **ROSIE**, **Bug Reports**, and **ROS Dev Center** are grouped at the end for support and system administration.

## Sidebar order

Settings appears in this order:

1. **Profile**
2. **General**
3. **Staff Access Defaults**
4. **Online Store**
5. **Printers & Scanners**
6. **Receipt Settings**
7. **Tag Designer**
8. **Terminal Overrides**
9. **Data & Backups**
10. **Remote Access**
11. **Integrations**
12. **Podium**
13. **Shippo**
14. **Stripe**
15. **QuickBooks**
16. **Counterpoint**
17. **NuORDER**
18. **Weather**
19. **Insights**
20. **Meilisearch**
21. **Help Center**
22. **ROSIE**
23. **Bug Reports**
24. **ROS Dev Center**

## Staff access defaults

**Purpose:** **Template** permission matrix and **template** max-discount-% rows per **`salesperson`** / **`sales_support`** / **`admin`**. Used when onboarding staff and when someone clicks **Apply role defaults** on **Staff → Team → Edit staff**.

1. **Settings** → **Staff access defaults** (requires **settings.admin** **or** **staff.manage_access**).
2. Edit **role permissions** and **role discount caps** with care; per-person edits stay on each profile in **Staff → Team**.

## Profile

1. **Settings** → **Profile**.
2. Update **Personal Info** (Name, Phone, Email) or your **Staff Icon**.
3. **CRM Linkage**: Link your profile to your customer account for automatic employee discount application and transaction history.
4. View-only access (POS mode): Identity-sensitive fields like **Role**, **Economics**, and **Permissions** are read-only to prevent unauthorized modification during sales operations; full management is available in the Back Office.
5. Save; the sidebar and top-bar identity will update instantly upon confirmation.

## General

Typical areas (labels may group differently by build):

### Store staff playbook

1. **Settings** → **General** → **Store staff playbook**.
2. Paste or write **Markdown** (suggested sections: [STORE-SOP-TEMPLATE.md](STORE-SOP-TEMPLATE.md)).
3. **Save playbook**; UTF-8 size must stay under the shown limit.
4. **Audit:** updates are logged as `staff_sop_update` in staff access history.

### Receipt and timezone

- Set **IANA timezone** (e.g. `America/New_York`) for **printed** timestamps and **business date** logic used in metrics.
- Edit **receipt header/footer**, tender labels — test **one** receipt after changes.

### Backups

- **List** backups; **create** manual backup before risky upgrades.
- **Download** to secure storage only.
- **Restore** is **destructive** — manager + SOP only.
- **Cloud sync** config (if enabled) lives in backup settings JSON.

### Database

- **Stats** — table sizes, health signals (**settings.admin**).
- **Optimize** — VACUUM-style maintenance; run in **low traffic** window per IT.

### Integrations tab

- **Visual Crossing (weather):** location, units, enable flag, API key — see [WEATHER_VISUAL_CROSSING.md](../WEATHER_VISUAL_CROSSING.md).
- **Counterpoint bridge:** Status, **Inbound staging** toggle, queue **Apply/Discard**, and **Maps**. To prevent console spam when you are away from the store, the bridge status panel will stop checking automatically after **3 failures**. Use the **[Reconnect]** button to resume monitoring.
- **Podium (SMS + web chat):** operational SMS templates, whether to send pickup/alteration texts through Podium, **location UID**, optional **storefront widget** snippet, a **readiness** line (env + webhook flags; no live Podium call), and a visible note when **API credentials** are missing on the server. OAuth **client id / secret / refresh token** and **webhook secret** are set only on the **API host** (environment variables), not in this screen. **Staff manuals:** [podium-integration-staff-manual.md](podium-integration-staff-manual.md) (quick tasks), [Podium_Integration_Manual.md](Podium_Integration_Manual.md) (full reference). Engineers: [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md), [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md).
- **Customers (CRM / hub):** **Operational SMS** (pickup / alterations) can be toggled separately from **marketing SMS** on the relationship hub and add-customer flows after migration **71** (see plan doc).
- **Never** paste API keys or Podium/NuORDER secrets into chat or screenshots.

## Help Center Manager

**Purpose:** Manage in-app Help Center manuals, policy overrides, automation workflows, and help-search indexing from one place.

**Where in ROS:** **Settings → Help Center Manager** (shown as **System & Health** section item).  
**Permission required:** **help.manage** (admin by default).

### Tabs and what they do

- **Library** — browse bundled manuals, see hidden/override status, and inspect source paths.
- **Editor** — update manual policy overrides:
  - hide/unhide manual
  - title/summary/order override
  - markdown override (or revert to bundled markdown)
  - required permission overrides
  - register-session visibility override
- **Automation** — run manual maintenance workflows that map to Help tooling:
  - bulk scaffold / rescan component manuals
  - optional orphan cleanup (for auto-scaffold manuals)
  - dry-run and include-shadcn options
  - command output (stdout/stderr) shown in panel
- **Search & Index** — monitor help-search health and reindex help content for search parity.

### Recommended admin workflow

1. Choose a manual in **Library**.
2. Apply policy/content changes in **Editor**.
3. Run **Automation** after structural manual changes (new/renamed/manual scaffold-rescan-cleanup operations).
4. Run **Search & Index → Reindex Help search** after meaningful text/heading updates.
5. Validate results in the **operation log** and spot-check Help drawer behavior in POS/Back Office.

### Quick-start checklist (daily use)

- Open **Settings → Help Center Manager**.
- Select the target guide in **Library** and verify it is not unintentionally hidden.
- Make edits in **Editor** and click **Save**.
- If you changed structure/metadata/scaffolding, run **Automation** (use **Dry run** first).
- Run **Search & Index → Reindex Help search** for search parity.
- Confirm success in **Operation logs** and quickly verify in Help drawer (POS + Back Office).

### Safety notes

- Prefer **Dry run** before scaffold/rescan/cleanup operations.
- **Cleanup** only targets eligible auto-scaffold/orphan docs; curated manuals should remain untouched.
- **Revert overrides** restores bundled defaults for the selected manual.

## Bug reports

**Staff — how to send a report:** **[bug-reports-submit-manual.md](bug-reports-submit-manual.md)** (bug icon in header or POS; screenshot optional; rate limits; privacy).

**Admins — triage playbook:** **[bug-reports-admin-manual.md](bug-reports-admin-manual.md)** (filters, detail drawer, downloads, tracker URL, internal notes, Fixed / Dismissed / Reopen, retention, notifications).

Short version: **Settings** → **Bug reports** (**`settings.admin`** only). Submissions include **correlation id**, optional **screenshot**, **server log snapshot** (bounded in-process **`tracing`** — not a full host log; **[OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md](../OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)**), and **client diagnostics**. The **Error events** tab automatically captures recent error toasts with route and lightweight diagnostics when staff do not file a full report. Treat both as **internal ops data** (PII risk). Retention: **`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`** — **`docs/PLAN_BUG_REPORTS.md`**.

## ROS Dev Center

**Purpose:** Developer/admin command center for operations health, station telemetry, alerts, guarded maintenance actions, and Bug Manager incident correlation.

**Where in ROS:** **Settings → ROS Dev Center**.  
**Permissions:** **`ops.dev_center.view`** for read access; **`ops.dev_center.actions`** to acknowledge alerts, run guarded actions, and link bugs to incidents.

### What to use it for

1. **Ops Health Board**: Confirm DB/API/integrations are healthy from one status panel.
2. **Station Fleet Board**: Verify each Register station heartbeat, version, and online/offline transitions.
3. **Runtime Diagnostics**: Confirm the station's resolved API base, strict-production status, Stripe readiness, Shippo mode, Metabase auth mode, help-search mode, and weather mode without exposing any secrets.
4. **Alert Center**: Acknowledge active incidents and verify suppression/recurrence behavior.
5. **Guarded Actions**: Run maintenance actions only with explicit reason + dual confirmation.
6. **Bug Manager Overlay**: Keep ROS bug reports as source-of-truth and attach bugs to active incidents for triage context.

### Current operator-visible fallback states

- **Insights**: if automatic Metabase sign-in is unavailable, the station shows an inline Riverside warning and continues to the normal Metabase sign-in screen.
- **Help Center**: if live search is unavailable, the drawer clearly indicates bundled/manual fallback mode.
- **Weather**: Operations and the POS dashboard show a `Mock Weather` badge and note when weather data is coming from mock mode.

### Guardrails

- Do not run guarded actions during business hours.
- Always include a meaningful reason (this is captured in immutable action audit history).
- Use Dev Center as operational control, not as a substitute for POS/Back Office transactional workflows.

## Online store

1. **Settings** → **Online store** (requires **online_store.manage** or admin).
2. **Pages:** create a **slug** (URL segment under **`/shop/`**) and **title**; use **Edit page** to write **HTML** or open the **Visual (Studio)** builder. **Publish** when the page should be visible to guests.
3. **Coupons:** create **web** promo codes (percent, fixed amount, or free-shipping kind per form); activate or deactivate as needed.
4. The **public storefront** (**`/shop`**) is separate from Back Office. Guests can browse without an account; customers may **register or sign in** under **`/shop/account`** (optional **profile**, **order history** for web orders). Those customers are still **one CRM row** with in-store customers — see [ONLINE_STORE.md](../ONLINE_STORE.md).

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Receipt time wrong | Fix timezone string | DEVELOPER / IT |
| Backup failed | Disk space | [BACKUP_RESTORE_GUIDE.md](../../BACKUP_RESTORE_GUIDE.md) |
| Weather stopped | Key rotation | Weather doc |
| 403 on General | Not **settings.admin** | Owner |
| Missing **Online store** tab | No **online_store.manage** and not admin | Owner / **Staff → Team** (access) or template in **Settings → Staff access defaults** |
| Missing **Help Center Manager** tab | No **help.manage** permission | Owner / admin updates role or individual access |
| Missing **ROS Dev Center** tab | No **ops.dev_center.view** permission | Owner / admin updates role or individual access |

## When to get a manager

- **Restore** from backup.
- **Tax** or **legal** receipt wording changes without corporate approval.

---

## See also

- [bug-reports-submit-manual.md](bug-reports-submit-manual.md) — reporting a bug (all staff)
- [bug-reports-admin-manual.md](bug-reports-admin-manual.md) — triage (**settings.admin**)
- [../../BACKUP_RESTORE_GUIDE.md](../../BACKUP_RESTORE_GUIDE.md)
- [../../REMOTE_ACCESS_GUIDE.md](../../REMOTE_ACCESS_GUIDE.md)
- [../WEATHER_VISUAL_CROSSING.md](../WEATHER_VISUAL_CROSSING.md)
- [../ONLINE_STORE.md](../ONLINE_STORE.md)
- [../ROS_DEV_CENTER.md](../ROS_DEV_CENTER.md)
- [../MANUAL_CREATION.md](../MANUAL_CREATION.md)
- [../NUORDER_INTEGRATION.md](../NUORDER_INTEGRATION.md)
- [pos-settings.md](pos-settings.md)

**Last reviewed:** 2026-04-21
