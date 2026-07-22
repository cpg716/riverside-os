---
id: settings-ros-dev-center-panel
title: "ROS Dev Center"
order: 1115
summary: "Developer and support diagnostics for checking Riverside OS health safely."
source: client/src/components/settings/RosDevCenterPanel.tsx
last_scanned: 2026-06-02
tags: settings-ros-dev-center-panel, support, diagnostics, dev-center
status: approved
---

# ROS Dev Center

## Screenshots

![ROS Dev Center overview](../images/help/settings-ros-dev-center-panel/workflow-1.png)

![Bug report dialog](../images/help/settings-ros-dev-center-panel/workflow-2.png)

![ROSIE settings](../images/help/settings-ros-dev-center-panel/workflow-3.png)

## What this is

ROS Dev Center is the protected diagnostics area for managers, support, and developers. It is not a daily staff workflow.

Use it to review health, recent incidents, guarded operations, and diagnostic history without leaving Riverside OS.

## How to use it

1. Open ROS Dev Center from the protected settings area.
2. Review available diagnostics and any degraded feed indicators.
3. Check the connection pool, server environment, E2E regression lane, and guarded action cards before escalating.
4. Share report IDs, routes, or correlation IDs with support.
5. Run protected actions only when a manager or developer asks for them.

## When to use it

Use ROS Dev Center when:

- support asks for workstation or app health
- a bug report needs deeper diagnostic context
- a guarded maintenance action needs manager review
- one operational feed is degraded and you need to see what is still available

## Degraded diagnostics

Diagnostic feeds load independently. If one feed fails, the rest of the Dev Center should still render useful information with a quiet degraded message for the failed feed.

That means a missing incident feed should not hide available audit history, protected actions, or system status.

Database diagnostics never turn a failed request into a disconnected pool with zero errors or zero migrations. When the current probe is unavailable, Riverside either keeps the last confirmed snapshot and labels it, or shows **Unavailable** and an em dash. Treat those states as missing evidence, not as zero activity.

The migration total comes from Riverside's active `ros_schema_migrations` ledger. If that ledger cannot be read, the diagnostic is **Unavailable**; Riverside does not report a fabricated zero.

## Protected actions

Only use protected operations when a manager or developer has asked for them. These actions are audit-sensitive and should remain traceable.

Before running any protected action:

- confirm the target workflow
- confirm the expected result
- avoid running maintenance during live checkout unless support says it is safe

## What to share with support

Share the report ID, route, correlation ID, degraded feed name, and visible error wording. Do not share Access PINs, passwords, tokens, card data, or private customer notes.

## What to watch for

- A degraded diagnostics feed does not mean every support feed is unavailable.
- Protected actions are audit-sensitive and should not be run casually.
- Staff-facing workflows should be rechecked after support says a fix is ready.
- A normal Main Hub update preserves installed ROSIE models and speech files. If Riverside OS updates successfully but ROSIE is unhealthy, use the separate ROSIE repair workflow instead of repeatedly running the Main Hub update.

## What happens next

After support reviews the diagnostic evidence, return to the staff workflow and confirm the screen now behaves normally.
