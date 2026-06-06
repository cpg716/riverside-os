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

ROSIE help should return from the approved local Host stack. If the local model host is slow or unavailable, ROSIE shows an unavailable state instead of substituting another assistant path. ROSIE does not replace the manual or the current screen state.

While ROSIE is answering, the drawer shows visible thinking and then streams the answer into the same message. Sources can appear before the answer is finished so staff can see which manuals, reports, Store SOP, or operational playbooks are being used.

Use sources to open the exact manual section ROSIE used. Non-manual sources, such as workflow playbooks or operational read tools, are shown as evidence chips but do not replace the current workflow screen.

ROSIE can show **Suggested Actions** for common recovery work, including register close blockers, refund recovery, inventory mismatches, QBO exceptions, receiving, inventory lookup, and appointment scheduling. Suggested Actions start a guided ROSIE follow-up; they do not submit workflow changes, approve exceptions, or bypass Manager Access.

Chat with ROSIE keeps a short session context, such as the current Help article and the last question/answer summary. This context helps ROSIE stay conversational, but live screen facts, server tool results, Store SOP, and manuals remain the source of truth.

## What to watch for

- If a manual cannot load, use search or try again later.
- If ROSIE is unavailable, continue with the staff manual and visible workflow controls, and report ROSIE as a Host stack issue.
- If a Suggested Action does not match the screen in front of you, follow the current workflow and ask a manager or support for help.
- Do not paste passwords, Access PINs, card numbers, or private customer notes into ROSIE.

## Related workflows

- [ROSIE Settings](manual:settings-rosie-settings-panel)
- [Bug Report Flow](manual:bug-report-flow)
