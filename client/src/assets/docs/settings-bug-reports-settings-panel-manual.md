---
id: settings-bug-reports-settings-panel
title: "Bug Reports Settings"
order: 1086
summary: "Review submitted bug reports and support diagnostics without exposing sensitive values."
source: client/src/components/settings/BugReportsSettingsPanel.tsx
last_scanned: 2026-05-10
tags: settings-bug-reports-settings-panel, support, diagnostics
status: approved
---

# Bug Reports Settings

## Screenshots

![Bug reports support center](../images/help/settings-bug-reports-settings-panel/workflow-1.png)

![Bug report dialog](../images/help/settings-bug-reports-settings-panel/workflow-2.png)

![ROS Dev Center](../images/help/settings-bug-reports-settings-panel/workflow-3.png)

## What this is

Bug Reports Settings is the support review area for submitted reports and automated diagnostic incidents. It is split into two primary areas:
- **Staff reports:** Manual tickets submitted directly by staff with custom context and optional screenshots.
- **Automated diagnostics:** Actionable failures and retained support evidence captured from both the server and client runtimes.

Routine field guidance is not a product failure. For example, choosing **Save email** with an empty email field shows a warning and is not added to Automated diagnostics. Previously retained copies of that guidance appear only as **Background info**.

It helps managers and support staff see what was reported, which workstation or route was involved, and whether the captured diagnostics are enough to reproduce the problem. It is also available in the standalone **Dev Ops Center** macOS app for immediate offline diagnostic collection and copy-to-clipboard AI diagnostics formatting.

## How to use it

1. Open Bug Reports Settings from the protected settings area (or open the Standalone macOS DevOps application).
2. Select **Staff reports** or **Automated diagnostics**.
3. In Automated diagnostics, start with **Action needed**. Use **Recurring** for repeated connection evidence and **Background info** for retained validation or setup context. Select an incident to open its details dialog; detailed browser and server diagnostics load after you choose **View**.
4. Use **Copy AI Package** to grab the pre-packaged context, error logs, and system variables formatted as a developer prompt, ready to paste directly into AI editors.
5. Use the download buttons in the details dialog to save the AI diagnostic JSON, screenshot PNG, support log, or browser log. ROS shows a saved or failed message after the desktop save finishes.
6. Use **Download AI Diagnostic** on automated diagnostics to save the diagnostic payload as an `.md` report.
7. Share the report ID or correlation ID with support when needed.

## When to use it

Use this panel when:

- staff submitted a bug report from the app
- support needs the latest report details
- a diagnostic incident needs review
- a developer asks for the report ID, route, or correlation ID

## What to review

- **Report summary:** what staff said happened.
- **Workflow context:** route, surface, browser, viewport, and workstation metadata.
- **Recent safe diagnostics:** redacted console and error context.
- **Screenshot:** only when staff attached one.
- **Incident status:** whether the report still needs follow-up.

## Privacy behavior

Diagnostics are redacted before they are submitted or downloaded. Authorization headers, bearer tokens, JWT-looking strings, cookies, session values, Access PIN-like fields, passwords, secrets, token fields, API key fields, obvious customer contact fields, and URL query values should not appear in report evidence.

If a report includes sensitive text typed by a person into a description, treat it as private and remove or replace it before sharing.

## Degraded diagnostics

If one support feed cannot load, the panel should still show the other available report information. A quiet degraded message means that only part of the diagnostic history is unavailable.

## What happens next

Use the report details to reproduce the issue or hand the report ID to support. Do not mark an incident resolved until the staff-facing workflow has been checked again.
