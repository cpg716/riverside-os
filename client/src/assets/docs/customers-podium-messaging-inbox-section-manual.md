---
id: customers-podium-messaging-inbox-section
title: "Podium Inbox"
order: 1007
summary: "Review shared Podium SMS and email threads from Operations or POS, then open the full conversation in the Customer Hub."
source: client/src/components/customers/PodiumMessagingInboxSection.tsx
last_scanned: 2026-08-10
tags: customers, podium, messaging, inbox, communications
---

# Podium Inbox

## Screenshots

![Customers workspace](../images/help/customers-podium-messaging-inbox-section/customers-workspace.png)

![Podium settings](../images/help/customers-podium-messaging-inbox-section/podium-settings.png)

![Operations inbox context](../images/help/customers-podium-messaging-inbox-section/operations-inbox-context.png)

## What this is

Podium Inbox is the shared list of recent Podium SMS and email conversations.

Sending a staff-authored text requires **Settings → Integrations → Podium → Staff-authored texts**. That switch does not enable automated pickup, alteration, appointment, receipt, new-sender, or review messages.

In Operations and POS, this surface is for communications follow-up only. It is not a general task inbox.

## How to use it

1. Open **Operations** → **Podium Inbox** or **POS** → **Podium Inbox**.
2. Review the most recent customer conversation rows.
3. Open a row to read and reply in the thread.
4. Use **Open Customer** when the conversation changes an order, pickup, alteration, shipment, or wedding party plan.

## Operational detail

Use this inbox to decide who needs a response, not to replace the Customer Hub. A recent message without a linked customer should be handled carefully: search the customer first, confirm phone or email ownership, then create or link a contact only when staff can identify the person.

The screen refreshes the Riverside copy every minute while it is open. Podium webhooks are still the fastest path for new inbound messages; Riverside stores verified webhook events in a retryable queue before acknowledging them. **Refresh** reloads only the Riverside copy. **Pull from Podium** fills missed history using Podium's cursor-paged conversation and message APIs, and Riverside also runs a background pull when history is more than 30 minutes old. **History current** appears only after every matched conversation history in the pull is stored. If the Inbox reports **History incomplete**, retry the pull once and escalate the displayed failure if it remains.

Under **Unknown Podium senders**, choose **Match customer**, search for the intended existing customer, confirm the phone/email belongs to that person, and select the record. When multiple customers share an identifier, Riverside labels the collision and refuses to choose silently. The resolution is stored against the exact Podium conversation ID and later synchronization clears the item from the unmatched queue.

## Tips

- Use this list to triage communication work quickly from either shell.
- If you need the full customer record, open the row instead of trying to work from the list alone.
- **ROS webhook ready** means Riverside has its local signing secret and inbound processing enabled. The provider subscription can still require an update; Settings → Integrations → Podium is authoritative for that status.
- **History current** means the last matched conversation histories completed. **History incomplete** means at least one history is missing, failed, or due for a provider pull.
- A collision warning means staff must verify identity; do not select a customer solely because they are the newest record.

## What happens next

After a row opens, continue from the full customer conversation. Add notes or follow-up tasks in the customer workflow when the conversation changes the customer's order, appointment, wedding party, alteration, or pickup plan. If the message belongs to a new number, collect first and last name before creating a new contact.


## Escalation

Escalate when a message includes payment disputes, return promises, customer-data corrections, angry language, or a request that affects a wedding party, pickup, alteration, or shipment timeline. Staff should not promise refunds, delivery dates, or account corrections from the inbox row alone.


If the customer identity is uncertain, ask for enough detail to match an existing customer before linking the thread.

## Related workflows

- [Customers Workspace](manual:customers-workspace)
- [Customer Relationship Hub](manual:customers-customer-relationship-hub-drawer)
