# Settings (Back Office)

**Audience:** Store admins.

**Where in ROS:** Back Office → **Settings**. The settings workspace opens to the **Settings Hub**, with links grouped into practical neighborhoods: **Store Setup**, **Register Setup**, **Maintenance**, **Integrations**, and **System & Support**.

**Related permissions:** **settings.admin** for most store-wide configuration. **Staff access defaults** is visible with **settings.admin** **or** **staff.manage_access** (role permission templates + template discount caps). **Online store** uses **online_store.manage** (admins also have access via **settings.admin** on the same APIs). **Profile** / **avatar** may be self-service for any signed-in staff.

---

## How to use this area

Use **Settings Hub** when you are not sure where to start. **Profile** changes **you**. **General** changes **the store** (theme, **store staff playbook**, build info). **Online store** covers **marketing pages** for the public **`/shop`** site and **web coupons** — see **§ Online store** below. **Printers & Scanners**, **Receipt Settings**, **Tag Designer**, and **Terminal Overrides** stay together for register setup. **Integrations Overview** is an optional landing page; each third-party bridge also remains directly reachable in the same group. **Help Center**, **ROSIE**, **Bug Reports**, and **ROS Dev Center** are grouped at the end for support and system administration.

## Sidebar order

Settings appears in these sidebar groups:

**Store Setup**
1. **Settings Hub**
2. **Profile**
3. **General**
4. **Staff Access Defaults**
5. **Online Store**

**Register Setup**
1. **Printers & Scanners**
2. **Receipt Settings**
3. **Tag Designer**
4. **Terminal Overrides**

**Maintenance**
1. **Data & Backups**
2. **Daily Financial Report**
3. **Remote Access**
4. **Updates** *(via ROS Dev Center → Updates tab)*

**Integrations**
1. **Integrations Overview**
2. **Podium**
3. **Shippo**
4. **Helcim**
5. **RMS Charge diagnostics**
6. **Fal.ai**
7. **QuickBooks**
8. **Counterpoint**
9. **NuORDER**
10. **Weather**
11. **Insights**
12. **Meilisearch**

**System & Support**
1. **Help Center**
2. **ROSIE**
3. **Bug Reports**
4. **ROS Dev Center**

## Helcim

**Purpose:** Confirm Helcim configuration/readiness. Z-close card outcome review can be handled inside POS close or **POS → Payments**; batching, deposits, QBO-facing work, and broader provider diagnostics remain in **Back Office → Payments**.

1. **Settings** → **Helcim**.
2. Confirm **API access** and **API host** are healthy before using Helcim batch, transaction, settlement, or fee sync.
3. Confirm **Terminal 1** and **Terminal 2** device codes before processing live in-store terminal payments or refunds.
4. Use **Payments → Health** or **Payments → Overview** for daily **Sync Batches** and **Sync Fees** work. ROS pulls fee/net fields from Helcim only when Helcim explicitly exposes them and leaves unavailable rows clearly counted. Missing fee/net values are tracked, not estimated and not treated as `$0.00`.
5. Use **Payments → Batches**, **Reconciliation**, and **Deposits** to review processor batches, issue history, expected deposits, and actual bank deposits.
6. QBO uses one **Helcim card clearing** tender mapping for Helcim card, manual, saved-card, refund/credit, and web checkout payments.

## Staff access defaults

**Purpose:** **Template** permission matrix and **template** max-discount-% rows per **`salesperson`** / **`sales_support`** / **`admin`**. Used when onboarding staff and when someone clicks **Apply role defaults** on **Staff → Team → Edit staff**.

1. **Settings** → **Staff access defaults** (requires **settings.admin** **or** **staff.manage_access**).
2. Edit **role permissions** and **role discount caps** with care; per-person edits stay on each profile in **Staff → Team**.

## Profile

1. **Settings** → **Profile**.
2. Update **Personal Info** (Name, Phone, Email), your **Staff Icon**, or your **Staff Photo**.
3. **Staff Photo**: Upload a real photo (JPEG, PNG, or WebP, max 10 MB). The system automatically detects the face, crops to a square, and resizes to a uniform 512x512 avatar. Your photo appears everywhere your avatar is shown — Top Bar, Register Overlay, Staff Roster, Notifications, and Staff Search. To revert to an icon avatar, delete the photo.
4. **CRM Linkage**: Link your profile to your customer account for automatic employee discount application and transaction history.
5. **Personal Purchases**: Once linked to your CRM customer profile, a "Purchase History" section will appear at the bottom of the page, allowing you to search past purchases, review applied discounts, and view/reprint receipts.
6. **View-only access (POS mode)**: Identity-sensitive fields like **Role**, **Economics**, and **Permissions** are read-only to prevent unauthorized modification during sales operations; full management is available in the Back Office.
7. **Save**: Save your profile changes; the sidebar and top-bar identity will update instantly upon confirmation.

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
- **Download** to secure storage only. Treat downloaded snapshots as sensitive customer and financial data.
- **Restore** is **destructive** — manager + SOP only.
- **Cloud sync** can send backups to S3-compatible storage, OneDrive, Google Drive, or Dropbox when credentials are configured.
- **Replication folders** copy verified backups to mounted/synced folders such as NAS shares, mapped Windows drives, external drives, or cloud desktop sync folders.
- **Encrypted archives** require the server recovery key. Do not enable encryption until `RIVERSIDE_BACKUP_ENCRYPTION_KEY` is recorded in the approved recovery bundle.

### Daily Financial Report

- **Enable/Disable**: Master toggle for report generation and storage.
- **Auto-Send After Close**: When enabled, the report is automatically emailed to all configured recipients after Z-close.
- **Recipient Emails**: Add/remove email addresses that receive the daily report.
- **Subject Template**: Customize the email subject; `{date}` is replaced with the business date.
- **Include QBO Status**: Toggle QBO journal sync status badge in the report.
- **Include Inventory Activity**: Toggle receiving/freight activity in the report.
- **Generate**: Manually create a report for any date.
- **Generate & Send**: Create and email a report to all recipients.
- **Test Send**: Send the most recent completed report with `[TEST]` prefix. Supports email override.
- **Report History**: View all generated reports with net sales, status badges, and actions to **View** (in-app HTML preview) or **Resend**.
- See [../DAILY_FINANCIAL_REPORT.md](../DAILY_FINANCIAL_REPORT.md) for API details and email template specs.

### Database

- **Stats** — table sizes, health signals (**settings.admin**).
- **Optimize** — VACUUM-style maintenance; run in **low traffic** window per IT.

### Integrations tab

- **Visual Crossing (weather):** location, units, enable flag, API key — see [WEATHER_VISUAL_CROSSING.md](../WEATHER_VISUAL_CROSSING.md).
- **Geoapify:** address lookup API key used for customer, vendor, and shipping address suggestions. Suggestions are local to the store service area around ZIP **14043**; Shippo remains the final selected-address validation and ZIP normalization layer.
- **Counterpoint import:** Use **Import & Proof** first: confirm the Bridge is connected, run the Bridge import, then review landed rows, exceptions, and blockers. **Sent** means the Bridge posted rows to ROS; **Landed** means ROS wrote and linked those rows for proof. Use **Customer Duplicates** after customers land. **Support Diagnostics** is for recovery and deeper troubleshooting, not the normal go-live path.
- **Helcim:** card processor API token, Terminal 1 / Terminal 2 device codes, public webhook delivery path, supported webhook events, optional webhook signing secret, and test mode. **Webhook received by ROS** means a signed delivery was stored; **Provider event attached to ROS checkout** means ROS matched that provider event to one safe pending checkout attempt. Staff use **POS → Payments** for daily terminal/card review; managers use **Back Office → Payments → Health** for deeper payment update review.
- **Podium (SMS + web chat):** operational SMS templates, whether to send pickup/alteration texts through Podium, **location UID**, optional **storefront widget** snippet, readiness checks, OAuth **Client ID / Client Secret / refresh token**, **API Host / OAuth Token URL**, and **webhook secret**. Routine credentials are saved in Settings through encrypted integration credentials. Start Podium authorization from this card only after Client ID and Client Secret show as saved. The refresh token is normally saved automatically after the Podium authorization flow. The webhook URL must be a public HTTPS Riverside URL, not `localhost`. **Staff manuals:** [podium-integration-staff-manual.md](podium-integration-staff-manual.md) (quick tasks), [Podium_Integration_Manual.md](Podium_Integration_Manual.md) (full reference). Engineers: [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md), [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md).
- **RMS Charge:** current pilot operations use the manual RMS/R2S workflow. Do not treat Settings credentials or diagnostics as automatic RMS posting approval.
- **Customers (CRM / hub):** **Operational SMS** (pickup / alterations) can be toggled separately from **marketing SMS** on the relationship hub and add-customer flows after migration **71** (see plan doc).
- **Fal.ai:** API key and optional webhook base URL override configuration. Enables high-performance image generation pipelines for Staff Avatars, product listings, and storefront page builders. Displays account details, real-time credit balance, usage costs, and a local history table of completed/failed visual generation jobs.
- **Never** paste API keys or integration secrets into chat, notes, customer records, or screenshots. Routine integration credentials belong in Backoffice Settings. The root encryption key (`RIVERSIDE_CREDENTIALS_KEY`, with `QBO_TOKEN_ENC_KEY` only as a transitional fallback) remains a deployment-level secret.

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

## Remote Access

**Purpose:** Manage and monitor off-site remote access to the store server.

**Where in ROS:** **Settings → Remote Access** (on the dedicated host machine).

1. Confirm **Shop Host** is running if this machine serves local-network satellite clients.
2. View the **local satellite URL** and **LAN IPv4** for in-store devices.
3. View **Tailscale connection status** — shows whether the server PC is connected to the Tailscale private network.
4. Use the **Tailscale / Remote Address** saver in the **sign-in gate** (not in this panel) to save the store's Tailscale address on client devices for quick-pick remote access.

For full setup and per-device Tailscale instructions, see [remote-access-tailscale.md](remote-access-tailscale.md) (staff) and [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) (IT/owner).

## Bug reports

**Staff — how to send a report:** **[bug-reports-submit-manual.md](bug-reports-submit-manual.md)** (bug icon in header or POS; screenshot optional; rate limits; privacy).

**Admins — triage playbook:** **[bug-reports-admin-manual.md](bug-reports-admin-manual.md)** (filters, detail drawer, downloads, tracker URL, internal notes, Fixed / Dismissed / Reopen, retention, notifications).

Short version: **Settings** → **Bug reports** (**`settings.admin`** only). Submissions include **correlation id**, optional **screenshot**, **server log snapshot** (bounded in-process **`tracing`** — not a full host log; **[OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md](../OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)**), and **client diagnostics**. The **Error events** tab automatically captures recent error toasts with route and lightweight diagnostics when staff do not file a full report. It also shows server-side operational issues from ROS Dev Center as **Server runtime** events when the server can still write to the database. Treat both as **internal ops data** (PII risk). Retention: **`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`** — **`docs/PLAN_BUG_REPORTS.md`**.

## ROS Dev Center

**Purpose:** Developer/admin command center for operations health, station telemetry, alerts, guarded maintenance actions, and Bug Manager incident correlation.

**Where in ROS:** **Settings → ROS Dev Center**.  
**Permissions:** **`ops.dev_center.view`** for read access; **`ops.dev_center.actions`** to acknowledge alerts, run guarded actions, and link bugs to incidents.

### What to use it for

1. **Ops Health Board**: Confirm DB/API/integrations are healthy from one status panel.
2. **Station Fleet Board**: Verify each Register station heartbeat, version, active offline state, and stale-history retention state.
3. **Runtime Diagnostics**: Confirm the station's resolved API base, strict-production status, Helcim readiness, Shippo mode, Metabase auth mode, help-search mode, weather mode, backup path, and station lifecycle governance without exposing any secrets.
4. **Alert Center**: Acknowledge active incidents and verify suppression/recurrence behavior.
5. **Guarded Actions**: Run maintenance actions only with explicit reason + dual confirmation.
6. **Bug Manager Overlay**: Keep ROS bug reports as source-of-truth and attach bugs to active incidents for triage context.
7. **Updates tab**: Manage and monitor software updates for the Main Hub server, Windows desktop app, and PWA clients.

### Updates tab (Settings → ROS Dev Center → Updates)

**Update order is enforced:** the Main Hub server must update first. Client update buttons are disabled with an explanation until the server is confirmed up to date.

| Section | What it does |
|---|---|
| **Main Hub Server** | Shows current server version and build SHA. Displays whether a newer version or same-version rebuild is available. The update downloads the matching Windows deployment package and verifies its build SHA before launching the elevated runner. Daily update check runs automatically at 2 AM and notifies admin staff. |
| **Windows app (Back Office / Register)** | Check for and install signed Tauri desktop app updates from the Windows app updater release assets. Button is disabled if server has not updated yet. |
| **PWA update status** | Shows whether the PWA served by the server matches the latest client build. |

**Same-version rebuilds:** the system detects when a new build of the same release version is published (using a build SHA fingerprint) — not just version number changes. Main Hub updates must match that build SHA before the installer runs, so hotfixes and rebuild deployments are not silently mixed with an older package.

**Update sequence (always follow this order):**
1. Main Hub server updates first (via ROS Dev Center → Updates → Main Hub Server).
2. Confirm server is healthy (Ops Health Board shows green).
3. Windows desktop apps (Back Office, Register) update via the same Updates tab.
4. PWA clients (iPads, phones) auto-update on next page load — no manual action needed.

> **Tailscale / Remote connection:** if working off-site, the server connection must be set to the Tailscale address before using this panel. See [remote-access-tailscale.md](remote-access-tailscale.md).

### Current operator-visible fallback states

- **Insights**: if automatic Metabase sign-in is unavailable, the station shows an inline Riverside warning and continues to the normal Metabase sign-in screen.
- **Help Center**: if live search is unavailable, the drawer clearly indicates bundled/manual fallback mode.
- **Weather**: Operations and the POS dashboard show a `Mock Weather` badge and note when weather data is coming from mock mode.

### Standalone ROS Dev Center App (macOS)
For remote administrative management, developers and admins can run the standalone macOS Dev Center companion app. It supports:
- **Zero-Secret Server Profiles**: Configures connections to local/staging/production instances.
- **Keychain PIN Storage**: Staff Access PINs are stored securely via the native system Keychain instead of plaintext files on disk.
- **Native Auto-Discovery**: Rapidly scans Tailscale networks and local subnets via concurrent Rust sweeps to discover active server hosts.
- **ROSIE AI Diagnostics**: Interrogates local Gemma LLM instances to analyze recent warning/error server logs and recommend file-level code patches.

### Guardrails

- Do not run guarded actions during business hours.
- Always include a meaningful reason (this is captured in immutable action audit history).
- Use Dev Center as operational control, not as a substitute for POS/Back Office transactional workflows.


## Online store

1. **Settings** → **Online store** (requires **online_store.manage** or admin).
2. **Pages:** create a **slug** (URL segment under **`/shop/`**) and **title**; use **Edit page** to write **HTML** or open the **Visual (Studio)** builder. **Publish** when the page should be visible to guests.
3. **Coupons:** create **web** promo codes (percent, fixed amount, or free-shipping kind per form); activate or deactivate as needed.
4. The **public storefront** (**`/shop`**) is separate from Back Office. Guests can browse without an account; customers may **register or sign in** under **`/shop/account`** (optional **profile** and web purchase history). Those customers are still **one CRM row** with in-store customers — see [ONLINE_STORE.md](../ONLINE_STORE.md).

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
- [../DAILY_FINANCIAL_REPORT.md](../DAILY_FINANCIAL_REPORT.md)
- [pos-settings.md](pos-settings.md)

**Last reviewed:** 2026-05-27
