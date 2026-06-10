---
id: settings-rosie-settings-panel
title: "ROSIE Settings"
order: 1116
summary: "Control ROSIE help, insight, voice, provider status, and required Host behavior for the workstation."
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

ROSIE Settings controls the help and insight assistant for the workstation and shows whether the selected ROSIE provider is healthy.

ROSIE is secondary to Riverside OS facts. Staff should rely on deterministic cards, tables, totals, blockers, warnings, and workflow actions first.

## How to use it

1. Open ROSIE Settings from Settings.
2. Review whether help, insight, voice, and required Host stack behavior are enabled.
3. Adjust only the station behavior that support or management asked to change.
4. Return to the workflow and confirm deterministic content still appears first.

## When to use it

Use this panel when:

- ROSIE help or chat should be turned on or off for a station
- voice input or spoken responses need to be adjusted
- the local Gemma, Remote LM Studio, OpenAI, or Gemini provider status needs review
- speech-to-text and speech output routing need confirmation
- support asks whether ROSIE is available on the workstation

## Insight behavior

ROSIE insight buttons do not run automatically when a screen opens. Staff choose when to request an explanation.

If ROSIE is unavailable, insight panels show a short unavailable note and return control without blocking the underlying workflow. The deterministic screen content stays visible and usable, but ROSIE should be treated as unhealthy until the Host stack is repaired.

## Voice behavior

Voice controls only appear when the workstation supports the approved SenseVoice and Kokoro Host paths. Spoken responses come from the configured Riverside host path, not from browser text-to-speech.

The selected chat provider is configured on the Riverside server. The panel can show Local Gemma, Remote LM Studio, OpenAI, or Gemini. Speech-to-text and speech output have their own selected provider, so the store can use Remote LM Studio for chat while keeping SenseVoice and Kokoro local for voice.

If a selected provider is not configured or cannot be reached, ROSIE returns an explicit provider error instead of silently switching providers.

Voice workflow prompts are designed for hands-busy assistance. Staff can use them for receiving guidance, inventory lookup, and appointment detail capture, but ROSIE only guides the workflow. Final receiving, inventory, refund, register close, QBO, and scheduling actions still happen in the normal Riverside OS screen with the required staff or manager confirmation.

## Status wording

Use staff-facing status labels. Avoid internal runtime terms when explaining the station to staff.

## Operational detail

ROSIE settings control assistance, not source-of-truth behavior. Turning ROSIE off should never hide deterministic workflow facts, totals, warnings, or manual access. If ROSIE gives an answer that conflicts with the current screen or a manager decision, follow the screen/manual and log the ROSIE grounding issue.

Provider mode is server-owned. Support configures it with environment variables such as `ROSIE_PROVIDER=local_llm`, `ROSIE_PROVIDER=remote_lmstudio`, `ROSIE_PROVIDER=openai`, or `ROSIE_PROVIDER=gemini`, plus `ROSIE_STT_PROVIDER` and `ROSIE_TTS_PROVIDER` for voice. API keys must stay on the server and must not be entered into browser fields, staff notes, or client-side settings.


## What to watch for

- Do not use ROSIE to approve financial, register, Counterpoint, or QBO sign-off decisions.
- Do not treat voice output as proof that a workflow was completed; verify the visible screen state.
- Do not paste Access PINs, tokens, card numbers, or private customer notes into ROSIE.
- If the selected provider is offline, continue using manuals and deterministic workflow screens, and report ROSIE as a provider issue.
- If OpenAI or Gemini cloud mode is selected, report missing API key or model errors as provider configuration issues; do not switch to a local fallback unless management explicitly changes the provider mode.
