# Bug reports — admin triage manual

**Audience:** Staff with **`settings.admin`** (often store **owner**, **IT**, or delegated **operations lead**).

**Where in ROS:** Back Office → **Settings** → **Bug reports**.

**Who can submit reports:** Any **authenticated** staff from the **bug** icon in the **header** or **POS** top bar — see **[bug-reports-submit-manual.md](bug-reports-submit-manual.md)**.

---

## Why this screen exists

Submissions land in **`staff_bug_report`** with optional **PNG screenshot**, **summary**, **steps**, **client console buffer**, **client metadata** (build, URL, tab/subsection, register session flags, Tauri/PWA/browser surface), **correlation id**, and a **server log snapshot** captured at submit time (bounded **in-memory `tracing` ring** on the API process — **not** a full disk log or other servers). Automated **Error events** land in **`staff_error_event`** when the app shows an error toast, giving admins a lightweight trail even when staff do not file a full report. New reports can notify everyone with **`settings.admin`** (in-app notification with deep link toward **Settings → Bug reports**).

**Technical reference:** **[../PLAN_BUG_REPORTS.md](../PLAN_BUG_REPORTS.md)**  
**What the server snapshot is:** **[../OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md](../OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)**

---

## Access and permissions

| Action | Required |
|--------|----------|
| Open **Settings → Bug reports** | **`settings.admin`** |
| **List / view / PATCH** reports in the UI | **`settings.admin`** |
| **List / view Error events** | **`settings.admin`** |
| **Submit** a report (any staff) | Authenticated staff only (`POST /api/bug-reports`) |

If you need triage access but do not see **Bug reports**, an **admin** must grant **`settings.admin`** per **[STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)** / **[staff-administration.md](staff-administration.md)**.

---

## List view (queue)

After opening **Settings → Bug reports**:

1. Use **Refresh** if you expect a new row (or you opened the page before a colleague submitted).
2. **Filter chips** (counts in parentheses):
   - **Pending** — default; needs triage.
   - **Fixed** — marked complete (resolved in product or accepted workaround).
   - **Dismissed** — not actionable, duplicate, or “won’t fix.”
   - **All** — every row still retained by policy.

**Table columns:**

| Column | Meaning |
|--------|---------|
| **When** | Submitted timestamp (browser-local display). |
| **Ref** | First **8** characters of **correlation id** (matches staff toast prefix). |
| **Staff** | Submitter display name. |
| **Summary** | First lines of “what went wrong.” |
| **Status** | Pending / Fixed / Dismissed. |
| **View** | Opens the **detail** drawer. |

Empty states: **No bug reports yet** or **No reports in this filter**.

## Error events

The **Error events** tab is an automated companion to staff-submitted bug reports. It records recent error toasts with staff identity when available, route, client metadata, and a bounded API server log snapshot.

Use Error events to answer “what failed around this time?” quickly. Convert the pattern into a full bug report or external ticket when the same message repeats, affects checkout/order/payment flows, or needs engineering follow-up. Error events do **not** include screenshots or staff-written steps.

---

## Detail view (single report)

Open **View** on a row.

### Header strip

- **Timestamp** and **submitter**
- **Correlation:** full id (use this in tickets, Slack, or engineering handoffs)
- **Status** pill: **Pending**, **Fixed**, or **Dismissed** (labels shown as **Pending** / **Fixed** / **Dismissed**)
- Optional chips from client meta: **runtime** (Tauri / PWA / browser), **Tauri** version, **iOS / iPad-class** UA hint when detected

### Downloads (for IT / vendor / engineering)

| Button | Contents |
|--------|----------|
| **Full report JSON** | Entire payload: summary, steps, meta, base64 screenshot, server log text, triage fields, ids, timestamps. |
| **Screenshot PNG** | Image as stored (may be placeholder if staff unchecked capture). |
| **Server log (.txt)** | API **tracing** ring snapshot at **submit** time. |
| **Client console (.txt)** | Buffered client diagnostic log from the browser/WebView. |

**Important — server log:** The snapshot reflects **one API process** and a **recent window** of lines. Multi-instance deployments or restarts may mean **another replica** handled some traffic — treat as **supporting context**, not complete forensics.

### Triage (saved to database)

| Field | Use |
|--------|-----|
| **Tracker / issue URL** | External ticket (GitHub, Jira, Linear, etc.). Paste the canonical link. |
| **Internal notes (not visible to submitter)** | Repro notes, RCA, owner, workaround — **not** shown to the reporting employee in-app. |

Click **Save notes & URL** to persist before or after status changes (confirmation modals also send current draft **notes** and **URL** when you confirm a status transition).

### Screenshot and narrative (read-only in UI)

- **Screenshot** preview
- **What they were doing** — full **steps** text
- **Client meta** — JSON (navigation, build, viewport, user agent family, etc.)
- **API server log (snapshot at submit)** — scrollable block + reminder about bounded buffer
- **Browser console / error buffer** — scrollable block

### Status actions (with confirmation)

| Button | Effect |
|--------|--------|
| **Mark fixed** | Sets status to **complete** (shown as **Fixed**). Use when shipped fix, config correction, or accepted resolution is done. |
| **Dismiss (won’t fix)** | Sets status to **dismissed** — duplicate, user error, out of scope, or cannot reproduce with available info. |
| **Reopen as pending** | Available when status is **Fixed** or **Dismissed**; returns item to **Pending** for re-investigation. |

Each action opens a **Confirmation** modal explaining the transition. **Mark fixed** / **Dismiss** also pass your current **resolver notes** and **external URL** in the PATCH body.

**Close** dismisses the detail overlay without changing status (remember to **Save notes & URL** if you edited triage fields).

---

## Notifications

When a report is submitted, **settings admins** may receive an **in-app notification** linking to triage. Use your normal notification workflow (bell / inbox) and open **Settings → Bug reports** to match **correlation id** or time.

---

## Retention and compliance

- Rows may contain **PII** from screenshots and console text. Restrict access to **`settings.admin`** and standard **database** governance.
- The server **purges** reports older than **`RIVERSIDE_BUG_REPORT_RETENTION_DAYS`** (default **365**, minimum **30** per migration) during the daily maintenance window documented in **[PLAN_BUG_REPORTS.md](../PLAN_BUG_REPORTS.md)**. Export **JSON** or **PNG** before purge if **legal** or **vendor** asks for a long-term artifact.
- Optional browser **Sentry** (**`VITE_SENTRY_DSN`**) is separate from this table; it does not replace triage in ROS — see plan doc.

---

## Operational playbook

### Daily or weekly triage

1. Open **Pending** filter.
2. Oldest first (use **When** column) unless **sev1** register/Payments issues override.
3. For each item: read **steps**, glance **screenshot**, scan **client meta** for `ros_navigation`, check **server log** slice for obvious API errors.
4. Paste **tracker URL**, add **internal notes**, **Save notes & URL**.
5. **Mark fixed** when done; **Dismiss** when closed intentionally without a product change.

### Handoff to engineering

- Always attach or paste **full correlation id**.
- Prefer **Full report JSON** over screenshots alone (meta + server log in one file).
- Note **environment**: Tauri desktop vs PWA vs browser; **approximate store timezone** for “When.”

### Rate limiting for submitters

Staff are limited to **12** submissions per **15 minutes** per **staff id** (anti-spam). If someone hits the limit legitimately during an outage, coach them to **bundle** symptoms into **one** strong report; adjust firewall/support process rather than asking them to spam retry.

---

## Troubleshooting (admin UI)

| Symptom | Try |
|---------|-----|
| **Bug reports** missing from Settings | Your user lacks **`settings.admin`**. |
| List load errors | Reload; confirm API reachable; check **[ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md)** patterns. |
| Empty server log block | Submitter hit API that had **no recent tracing lines**, ring wrapped, or different replica — still use client meta + steps. |
| Screenshot is tiny/blank | Staff **unchecked** attach or capture **failed** — **placeholder** PNG stored. |

---

## When to escalate outside ROS

- Suspected **payment processor** or **bank** outage — follow merchant support SOP still.
- **Data breach** suspicion — follow **[PII-AND-CUSTOMER-DATA.md](PII-AND-CUSTOMER-DATA.md)** and corporate security, not only bug triage.

---

## See also

- **[bug-reports-submit-manual.md](bug-reports-submit-manual.md)** — coach staff on good reports.
- **[settings-back-office.md](settings-back-office.md)** — Settings navigation and other admin tabs.
- **[../PLAN_BUG_REPORTS.md](../PLAN_BUG_REPORTS.md)** — API paths, schema, env.

**Last reviewed:** 2026-04-08
