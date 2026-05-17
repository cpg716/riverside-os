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

![Help Center drawer](../images/help/help-center-drawer/example.png)

![Help Center settings](../images/help/settings-help-center-settings-panel/example.png)

![ROSIE settings](../images/help/settings-rosie-settings-panel/example.png)

## What this is

Bug Reports Settings is the support review area for submitted reports and diagnostic incidents.

It helps managers and support staff see what was reported, which workstation or route was involved, and whether the captured diagnostics are enough to reproduce the problem.

## How to use it

1. Open Bug Reports Settings from the protected settings area.
2. Select the report or incident needing review.
3. Check the route, summary, redacted diagnostics, and screenshot when present.
4. Share the report ID or correlation ID with support when needed.

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

Diagnostics are redacted before they are submitted or downloaded. Authorization headers, bearer tokens, JWT-looking strings, cookies, session values, Access PIN-like fields, passwords, secrets, token fields, and API key fields should not appear in report evidence.

If a report includes sensitive text typed by a person into a description, treat it as private and remove or replace it before sharing.

## Degraded diagnostics

If one support feed cannot load, the panel should still show the other available report information. A quiet degraded message means that only part of the diagnostic history is unavailable.

## What happens next

Use the report details to reproduce the issue or hand the report ID to support. Do not mark an incident resolved until the staff-facing workflow has been checked again.
