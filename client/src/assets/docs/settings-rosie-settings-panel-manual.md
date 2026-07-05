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

## Live data questions

Ask ROSIE can answer approved read-only live data questions through Riverside OS semantic tools. These tools are permission-gated, audited, row-limited, and shaped around business meanings instead of raw database tables.

Useful examples:

- What appointments do we have today?
- Which alterations are due this week?
- Which open orders are ready for pickup?
- Which customers have open balances?
- Which customers need follow-up today?
- Which wedding parties need attention this week?
- Which wedding members are missing measurements?
- Which wedding members still need fittings?
- Which wedding orders are ready for pickup?
- Which wedding members have open balances?
- What purchase orders are still open?
- What is on order from this vendor?
- What did we receive this week?
- Which vendor items are missing mappings?
- Which invoices need review?
- What should we reorder?
- How many navy suits sold in June?
- Do we have navy suits in inventory?
- What are our best sellers this month?
- Which inventory is stale?
- Give me a daily manager brief.
- What needs manager attention today?
- What data quality issues need cleanup?
- Are there QBO exceptions to review?
- What is the QBO sync status?
- Did yesterday's register close look normal?
- Are there gift card exceptions to review?
- How much outstanding credit liability exists?
- Which customers have store credit?
- Which customers have stale pickups?
- Which customers are missing phone or email?
- How many loyalty points does this selected customer have?

ROSIE may read and analyze approved data, but ROSIE cannot change Riverside OS records. ROSIE cannot adjust inventory, receive stock, fulfill pickup, refund, discount, reconcile a register, post QBO entries, change gift card or store credit balances, import data, merge customers, or edit staff records. Final changes must always happen in the normal Riverside OS workflow with the required Staff Access or Manager Access checks.

When ROSIE answers from live data, pay attention to the basis and limits. Examples include `booked_at`, `booked_at_sales_quantity`, `appointment_date`, `alteration_due_at`, `available_inventory`, `open_balance`, `loyalty_balance`, `wedding_readiness`, `wedding_readiness_event_date`, `wedding_follow_up_signals`, `open_purchase_orders`, `purchase_order_remaining_units`, `po_invoice_review`, `receiving_events`, `store_credit_balance`, `gift_card_liability_summary`, `credit_liability_summary`, `qbo_staging_status`, `qbo_sync_date`, `register_close_date`, `data_quality_counts`, `manager_attention_queue`, `store_local_today`, and `sales_velocity_45_days`. If ROSIE says the result is limited, open the relevant Riverside OS screen or report before acting on the full workload.

All live-data read tools require ROSIE audit logging. If Riverside OS cannot write the audit record, ROSIE blocks the answer instead of returning live operational data.

ROSIE uses approved semantic tools, not arbitrary SQL. If a question is unsupported, add a new approved read-only tool rather than giving ROSIE unrestricted database access. Sensitive tools such as gift card, store credit, QBO, register exception, and credit liability summaries require the existing Manager/Admin-style permissions for those Riverside OS areas.

## Voice behavior

Voice controls only appear when the workstation supports the approved SenseVoice and Kokoro Host paths. Spoken responses come from the configured Riverside host path, not from browser text-to-speech.

The selected chat provider is configured on the Riverside server. The panel can show Local Gemma, Remote LM Studio, OpenAI, or Gemini. Speech-to-text and speech output have their own selected provider, so the store can use Remote LM Studio for chat while keeping SenseVoice and Kokoro local for voice.

Use **ROSIE Provider Credentials** to add, replace, or clear the local/private/cloud provider endpoints, OpenAI and Gemini API keys, and cloud speech model names. These values are stored encrypted by Riverside OS. Environment values are fallback/bootstrap only.

If a selected provider is not configured or cannot be reached, ROSIE returns an explicit provider error instead of silently switching providers.

Voice workflow prompts are designed for hands-busy assistance. Staff can use them for receiving guidance, inventory lookup, and appointment detail capture, but ROSIE only guides the workflow. Final receiving, inventory, refund, register close, QBO, and scheduling actions still happen in the normal Riverside OS screen with the required staff or manager confirmation.

## Status wording

Use staff-facing status labels. Avoid internal runtime terms when explaining the station to staff.

## Operational detail

ROSIE settings control assistance, not source-of-truth behavior. Turning ROSIE off should never hide deterministic workflow facts, totals, warnings, or manual access. If ROSIE gives an answer that conflicts with the current screen or a manager decision, follow the screen/manual and log the ROSIE grounding issue.

Provider mode is server-owned. Support configures it with environment variables such as `ROSIE_PROVIDER=local_llm`, `ROSIE_PROVIDER=remote_lmstudio`, `ROSIE_PROVIDER=openai`, or `ROSIE_PROVIDER=gemini`, plus `ROSIE_STT_PROVIDER` and `ROSIE_TTS_PROVIDER` for voice. API keys must be entered only in **ROSIE Provider Credentials** or deployment fallback env, never in Vite/client env, staff notes, logs, or screenshots.


## What to watch for

- Do not use ROSIE to approve financial, register, Counterpoint, or QBO sign-off decisions.
- Do not treat voice output as proof that a workflow was completed; verify the visible screen state.
- Do not paste Access PINs, tokens, card numbers, or private customer notes into ROSIE.
- If the selected provider is offline, continue using manuals and deterministic workflow screens, and report ROSIE as a provider issue.
- If OpenAI or Gemini cloud mode is selected, report missing API key or model errors as provider configuration issues; do not switch to a local fallback unless management explicitly changes the provider mode.
