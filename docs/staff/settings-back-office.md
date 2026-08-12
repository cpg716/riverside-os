# Settings (Back Office)

**Audience:** Store admins.

**Where in ROS:** Back Office → **Settings**. The workspace opens to the searchable **Settings Hub**. The sidebar keeps **Settings Hub** visible and folds every setting into five task-based groups: **Store & Staff**, **Register & Printing**, **Data & Maintenance**, **Connected Services**, and **Help & System**.

**Related permissions:** **settings.admin** for most store-wide configuration. **Staff access defaults** is visible with **settings.admin** **or** **staff.manage_access** (role permission templates + template discount caps). **Online store** uses **online_store.manage** (admins also have access via **settings.admin** on the same APIs). **Profile** / **avatar** may be self-service for any signed-in staff.

---

## How to use this area

Use **Settings Hub** when you are not sure where to start. Choose one area from the category navigator to keep the workspace focused, or search by task, provider, or device across every area. **Profile** changes **you**. **Store & Staff** owns store-facing and staff defaults. **Register & Printing** keeps workstation hardware, receipts, tags, and lane preferences together. **Connected Services** owns each provider directly; the former duplicate **Integrations Overview** route now opens Settings Hub without removing any provider page. **Help & System** contains remote access, manuals and the store playbook, ROSIE, operational support, updates, bug review, and developer tools.

## Sidebar order

**Settings Hub** stays at the top. Select a group heading to expand or collapse its settings:

**Store & Staff**
1. **Profile**
2. **Staff Access Defaults**
3. **Online Store**
4. **Customer Reviews**

**Register & Printing**
1. **Printers & Scanners**
2. **Receipt Settings**
3. **Tag Designer**
4. **Terminal Overrides**
5. **Station & Network**

**Data & Maintenance**
1. **Data & Backups**
2. **Daily Financial Report**

**Connected Services**
1. **Podium**
2. **Email**
3. **Shippo**
4. **Helcim**
5. **Fal.ai**
6. **QuickBooks**
7. **Constant Contact**
8. **Counterpoint**
9. **NuORDER**
10. **Geoapify**
11. **Weather**
12. **Insights**
13. **Meilisearch**

When Meilisearch credentials are saved or cleared, Settings shows **Main Hub restart required**. The encrypted value is saved immediately, but application search does not fully activate the changed credential until the Main Hub process restarts.

**Help & System**
1. **Remote Access**
2. **Help Center**
3. **ROSIE**
4. **ROS Operations & Support Center** *(alerts, updates, and bug review)*
5. **ROS Dev Center**

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

## Store playbook and shared guidance

Typical areas (labels may group differently by build):

### Store staff playbook

1. **Settings** → **Help Center** → **Store playbook**.
2. Paste or write **Markdown** (suggested sections: [STORE-SOP-TEMPLATE.md](STORE-SOP-TEMPLATE.md)).
3. **Save playbook**; UTF-8 size must stay under the shown limit.
4. **Audit:** updates are logged as `staff_sop_update` in staff access history.

### Receipt Settings and timezone

- Open **Settings → Receipt Settings** to set the **IANA timezone** (e.g. `America/New_York`) used for printed timestamps and business-date logic.
- Edit the receipt header, footer, and tender labels there, then test **one** receipt after changes.

### Backups

- **List** backups; **create** a manual backup before risky upgrades, and wait for Riverside to confirm that the PostgreSQL archive was verified.
- **Download** to secure storage only. Treat downloaded snapshots as sensitive customer and financial data.
- **Restore** is **destructive** — manager + SOP only.
- **Cloud sync** can send backups to S3-compatible storage, OneDrive, Google Drive, or Dropbox when credentials are configured.
- **Replication folders** copy verified backups to mounted/synced folders such as NAS shares, mapped Windows drives, external drives, or cloud desktop sync folders.
- **Encrypted archives** require the server recovery key. Do not enable encryption until `RIVERSIDE_BACKUP_ENCRYPTION_KEY` is recorded in the approved recovery bundle.

### Daily Financial Report

- **Enable/Disable**: Master toggle for report generation and storage.
- **Auto-Send After Close**: When enabled, the archived report is automatically emailed to all configured recipients after Z-close. Email delivery is optional; the enabled master toggle still generates and archives the report without recipients.
- **Recipient Emails**: Add/remove email addresses that receive the daily report.
- **Subject Template**: Customize the email subject; `{date}` is replaced with the business date.
- **Include QBO Status**: Toggle QBO journal sync status badge in the report.
- **Include Inventory Activity**: Toggle receiving/freight activity in the report.
- **Generate**: Manually create a report for any date.
- **Generate & Send**: Create and email a report to all recipients.
- **Test Send**: Send the most recent completed report with `[TEST]` prefix. Supports email override.
- **Report History**: View all generated reports with basis-labeled net sales, status badges, and actions to **View** (in-app HTML preview) or **Resend**. New reports show booked net sales; older archived reports remain explicitly labeled as legacy recognized net sales. For a failed or partial delivery, **Resend** targets only recipients not already recorded as successful. Automatic failures also create a system alert for manager review.
- **Report content**: The email's first three cards use canonical booked Daily Sales, matching the ROS Today's Sales and booked Register report. Three more cards show month-to-date booked net sales plus the dollar and percentage comparison with the same month-to-date window last year. The body shows both exact date windows, separately labeled recognized revenue, and actual Visual Crossing business-day weather when available. Simulated weather is not shown as actual financial-report data.
- See [../DAILY_FINANCIAL_REPORT.md](../DAILY_FINANCIAL_REPORT.md) for API details and email template specs.

### Database

- **Stats** — table sizes, health signals (**settings.admin**).
- **Optimize** — VACUUM-style maintenance; run in **low traffic** window per IT.

### Connected services

- **Visual Crossing (weather):** location, units, enable flag, API key — see [WEATHER_VISUAL_CROSSING.md](../WEATHER_VISUAL_CROSSING.md).
- **Geoapify:** free-plan API key used for nationwide U.S. customer and shipping address suggestions, with Western New York ranked first. Selecting a result fills the form directly without calling Shippo. Shippo is used later only for shipping operations such as rates and labels.
- **Counterpoint transition:** Use **Import & Proof** only for the original cutover: confirm the Bridge is connected, run the Bridge import, then review landed rows, exceptions, and blockers. **Sent** means the Bridge posted rows to ROS; **Landed** means ROS wrote and linked those rows for proof. Use **Customer Duplicates** after customers land. After imports have ended, use **Legacy Order Repair** to review duplicate historical transaction shells and payments already stored in ROS. It repairs only exact matches, requires Manager confirmation, retains an audit snapshot, and leaves ambiguous rows unchanged. Bulk false-fulfillment and pickup-recognition recovery are **not available** in this release: the prototype is held outside the executable migration, API, and Settings paths. Do not use direct SQL. Escalate exact `TXN-` numbers with all ledger evidence; any existing payment allocation blocks automated status recovery because attachment history is not retained. The **Imported financial integrity** section separately compares header, line, tender, and booking evidence. **Align Booking Dates** changes only imported line and initial-booking timestamps; financial differences remain source-review items and no tender value is changed. If a source booking timestamp is missing or invalid, correct the Bridge/source value and rerun—the row stays in review rather than being stamped with today's import time. **Support Diagnostics** is for recovery and deeper troubleshooting.
- **Helcim:** card processor API token, Terminal 1 / Terminal 2 device codes, public webhook delivery path, supported webhook events, optional webhook signing secret, and test mode. **Webhook received by ROS** means a signed delivery was stored; **Provider event attached to ROS checkout** means ROS matched that provider event to one safe pending checkout attempt. Staff use **POS → Payments** for daily terminal/card review; managers use **Back Office → Payments → Health** for deeper payment update review.
- **Podium:** OAuth app keys and approval, provider-backed location selection, pinned API-version/readiness values, explicit provider webhook registration/update, independent Podium SMS workflows, health, and contact reconciliation. Store Email wording is under **Email**; review policy/wording under **Customer Reviews**; receipt captions/subjects under **Receipt Settings**; Podium web chat under **Online Store**. Routine credentials are encrypted in Settings. The webhook requires Riverside's public HTTPS URL and a shared signing secret; never use `localhost` in production. **Staff manual:** [podium-integration-staff-manual.md](podium-integration-staff-manual.md). Engineers: [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md), [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md).
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
3. View **Tailscale connection status** — shows whether the Main Hub is connected to the Tailscale private network.
4. Use the **Tailscale / Remote Address** saver in the **sign-in gate** (not in this panel) to save the store's Tailscale address on client devices for quick-pick remote access.

For full setup and per-device Tailscale instructions, see [remote-access-tailscale.md](remote-access-tailscale.md) (staff) and [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) (IT/owner).

## Bug reports

**Staff — how to send a report:** **[bug-reports-submit-manual.md](bug-reports-submit-manual.md)** (bug icon in header or POS; screenshot optional; rate limits; privacy).

**Admins — triage playbook:** **[bug-reports-admin-manual.md](bug-reports-admin-manual.md)** (filters, detail drawer, downloads, tracker URL, internal notes, Fixed / Dismissed / Reopen, retention, notifications).

Short version: **Settings** → **Bug reports** (**`settings.admin`** only). Submissions include **correlation id**, optional **screenshot**, **server log snapshot** (bounded in-process **`tracing`** — not a full host log; **[OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md](../OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)**), and **client diagnostics**. **Automated diagnostics** captures recent error toasts with route and lightweight diagnostics when staff do not file a full report. Similar events are grouped; **Action needed** opens first, while recurring connection noise and expected validation/setup messages remain available as **Recurring** or **Background info**. Server-side operational issues appear as **Server runtime** when the server can still write to the database. Treat both areas as **internal ops data** (PII risk). Retention: **`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`** — **`docs/PLAN_BUG_REPORTS.md`**.

## ROS Dev Center

**Purpose:** A clear daily operations list for staff, with developer/admin evidence available only when needed.

**Where in ROS:** **Settings → ROS Dev Center**.  
**Permissions:** **`ops.dev_center.view`** for read access; **`ops.dev_center.actions`** to acknowledge alerts, run guarded actions, and link bugs to incidents.

### What to use it for

1. **Operations Today**: Start here. Work **Do Now** from top to bottom, then handle **Needs Follow-Up**. Expand **Healthy systems** only when you want the current proof.
2. **Updates**: Manage and monitor software updates for the Main Hub server, Windows desktop app, and PWA clients.
3. **Advanced Diagnostics → Certification Evidence**: Review deployment, release, hardware, and owner signoff evidence. This is not a daily staff queue.
4. **Advanced Diagnostics → Workstations**: Verify Register heartbeat, version, offline state, and stale-history retention. One offline secondary workstation does not block opening while an active workstation remains online.
5. **Advanced Diagnostics → Alert History and Integration Details**: Inspect raw evidence and acknowledge an incident only after reviewing its source.
6. **Advanced Diagnostics → Register Performance**: Review 24-hour sample counts, median, p95, maximum duration, and failures. These measurements exclude customer, search, receipt, Access PIN, and card content and expire after 30 days.
7. **Advanced Diagnostics → Bug & Error Diagnostics**: Staff reports remain separate from automated diagnostics. Similar automated events are grouped and classified as **Action needed**, **Recurring**, or **Background info** so expected validation and setup messages do not inflate the action count.

Operations Today uses the live Main Hub readiness response, verified-backup evidence, workstation heartbeats, and open Register session ledger. Routine staff corrections, disabled services, stale history, and raw audit probes stay out of the daily action count but remain available in Advanced Diagnostics.

### Updates tab (Settings → ROS Dev Center → Updates)

**Update order is enforced:** the Main Hub server must update first. Client update buttons are disabled with an explanation until the server is confirmed up to date.

| Section | What it does |
|---|---|
| **Main Hub Server** | Shows current server version and build SHA. Displays whether a newer version or same-version rebuild is available. The update downloads the matching Windows deployment package, verifies its GitHub SHA-256 digest and embedded build SHA, then launches the elevated runner. Daily update check runs automatically at 2 AM and notifies admin staff. |
| **Windows app (Back Office / Register)** | Check for and install signed Tauri desktop app updates from the Windows app updater release assets. Button is disabled if server has not updated yet. |
| **PWA update status** | Shows whether the PWA served by the server matches the latest client build. |

**Same-version rebuilds:** the system detects when a new build of the same release version is published (using a build SHA fingerprint) — not just version number changes. Main Hub updates must match that build SHA before the installer runs, so hotfixes and rebuild deployments are not silently mixed with an older package.

**Desktop install telemetry:** Starting an app update records a pending native marker on that workstation. ROS does not report the update as installed when the package download finishes. After Riverside relaunches, the native shell compares the running version and build with the exact target; only a match sends the observed install time in the station heartbeat. A mismatched relaunch reports a failed observation for support review without inventing an install timestamp.

**Update sequence (always follow this order):**
1. Main Hub server updates first (via ROS Dev Center → Updates → Main Hub Server).
2. Confirm server is healthy (Ops Health Board shows green).
3. Windows desktop apps (Back Office, Register) update via the same Updates tab.
4. PWA clients (iPads, phones) auto-update on next page load — no manual action needed.

The Main Hub updater must verify the package digest, embedded build identity, and pre-migration backup before it stops the current server or replaces installed files. It also verifies installed ROSIE assets against the release pins, reuses exact matches, and certifies changed model/runtime assets before reporting success. If the update reports a package, backup, or ROSIE certification failure, do not reset or restore the database. Confirm the existing server is healthy, correct the reported failure, and rerun only with a fixed package. If an older package left the API offline, use ROS Server Manager or Administrator PowerShell (`Start-ScheduledTask -TaskName "Riverside OS Server"`) on the Main Hub, then confirm `http://127.0.0.1:3000/api/ready` so the database connection is also proven.

The Main Hub update button remains disabled when the update check does not provide an exact build identifier. Refresh the update check; do not bypass the hold or use a deployment ZIP from another build.

> **Tailscale / Remote connection:** if working off-site, the server connection must be set to the Tailscale address before using this panel. See [remote-access-tailscale.md](remote-access-tailscale.md).

### Current operator-visible fallback states

- **Insights**: the workspace shows Cube Core readiness and reports a clear unavailable state when the local semantic service or shared secret is not configured.
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
| 403 on a store-wide setting | Not **settings.admin** | Owner |
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

**Last reviewed:** 2026-08-09
