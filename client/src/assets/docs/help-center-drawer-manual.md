---
id: help-center-drawer
title: "Help Center Drawer"
order: 1011
summary: "Find staff manuals, print the current help section, and ask ROSIE for sourced help."
source: client/src/components/help/HelpCenterDrawer.tsx
last_scanned: 2026-05-10
tags: help-center-drawer, help, rosie, print
status: approved
---

# Help Center Drawer

## Screenshots

![Help Center settings](../images/help/settings-help-center-settings-panel/example.png)

![ROSIE settings](../images/help/settings-rosie-settings-panel/example.png)

![Help Center drawer](../images/help/help-center-drawer/example.png)
## What this is

Help Center is the in-app place for staff manuals, workflow search, and optional ROSIE help.

Deterministic help articles are primary. ROSIE can explain approved help content, but staff should follow the visible workflow facts and system messages on the screen.

## How to use it

1. Open Help from the top bar.
2. Search or choose a manual in Browse mode.
3. Print the current help article when a paper copy is needed.
4. Ask ROSIE only when an optional sourced explanation would help.

## Open Help

Select the **Help** icon from the top bar. The drawer opens without leaving the current workspace.

Use **Browse** to read manuals, **Ask ROSIE** for a sourced answer, or **Chat with ROSIE** when the station has ROSIE enabled.

## Search manuals

Type into the search box to find matching help sections. If live search is unavailable, Help Center falls back to saved help content on the station and shows a quiet message.

## Print the current help section

When a manual is open, select **Print** to print only the viewed help article.

Printed help includes:

- the help title
- the help body
- images already present in the help article

Printed help does not include:

- the app sidebar or top bar
- Help Center navigation and search controls
- ROSIE chat controls
- unrelated app chrome

The print action uses the browser print window. It does not create a PDF inside Riverside OS.

## Ask ROSIE

ROSIE help is optional. It should return quickly or fall back quietly if the local model host is slow or unavailable. ROSIE does not replace the manual or the current screen state.

Use sources to open the exact manual section ROSIE used.

## What to watch for

- If a manual cannot load, use search or try again later.
- If ROSIE is unavailable, continue with the staff manual and visible workflow controls.
- Do not paste passwords, Access PINs, card numbers, or private customer notes into ROSIE.

## Related workflows

- [ROSIE Settings](manual:settings-rosie-settings-panel)
- [Bug Report Flow](manual:bug-report-flow)
