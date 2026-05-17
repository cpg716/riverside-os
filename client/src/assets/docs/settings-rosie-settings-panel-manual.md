---
id: settings-rosie-settings-panel
title: "ROSIE Settings"
order: 1116
summary: "Control optional ROSIE help, insight, voice, and local model behavior for the workstation."
source: client/src/components/settings/RosieSettingsPanel.tsx
last_scanned: 2026-05-10
tags: settings-rosie-settings-panel, rosie, help, voice
status: approved
---

# ROSIE Settings

## Screenshots

![Help Center drawer](../images/help/help-center-drawer/example.png)

![Help Center settings](../images/help/settings-help-center-settings-panel/example.png)

![ROSIE settings](../images/help/settings-rosie-settings-panel/example.png)

## What this is

ROSIE Settings controls the optional help and insight assistant for the workstation.

ROSIE is secondary to Riverside OS facts. Staff should rely on deterministic cards, tables, totals, blockers, warnings, and workflow actions first.

## How to use it

1. Open ROSIE Settings from Settings.
2. Review whether help, insight, voice, and local model behavior are enabled.
3. Adjust only the station behavior that support or management asked to change.
4. Return to the workflow and confirm deterministic content still appears first.

## When to use it

Use this panel when:

- ROSIE help or chat should be turned on or off for a station
- voice input or spoken responses need to be adjusted
- the local model host or sidecar status needs review
- support asks whether ROSIE is available on the workstation

## Insight behavior

ROSIE insight buttons do not run automatically when a screen opens. Staff choose when to request an explanation.

If ROSIE is slow or unavailable, the insight request times out and returns to idle without blocking the workflow. The deterministic screen content stays visible and usable.

## Voice behavior

Voice controls only appear when the workstation supports them. Spoken responses come from the configured Riverside host path, not from browser text-to-speech.

## Status wording

Use staff-facing status labels. Avoid internal runtime terms when explaining the station to staff.

## Operational detail

ROSIE settings control assistance, not source-of-truth behavior. Turning ROSIE off should never hide deterministic workflow facts, totals, warnings, or manual access. If ROSIE gives an answer that conflicts with the current screen or a manager decision, follow the screen/manual and log the ROSIE grounding issue.


## What to watch for

- Do not use ROSIE to approve financial, register, Counterpoint, or QBO sign-off decisions.
- Do not paste Access PINs, tokens, card numbers, or private customer notes into ROSIE.
- If the local model host is offline, continue using manuals and deterministic workflow screens.
