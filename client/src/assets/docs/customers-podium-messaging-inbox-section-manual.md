---
id: customers-podium-messaging-inbox-section
title: "Podium Inbox"
order: 1007
summary: "Read and reply to shared Podium conversations, show linked staff assignments, manage read state, and close or reopen threads."
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
2. Use the conversation search and the **Open**, **Needs reply**, **Unread**, or **Closed** filter to find the customer.
3. Open a row to read and reply in the text-style thread. Opening the row marks that conversation read.
4. Use **Mark unread** when another staff member still needs to review the conversation. Use row checkboxes to mark several conversations read or unread together.
5. Use **Close** to move a conversation into Podium's closed/archive state. Find it under **Closed** and choose **Reopen** when follow-up resumes. Group Close/Reopen reports partial provider failures.
6. Check **In conversation** for the assigned staff. Linked Riverside names appear in green; **Not linked** means a manager must connect that Podium identity under **Staff → Team → Edit → Linked Podium Staff Member**.
7. Choose **New message** only when starting a separate text; the customer/phone form stays hidden during normal inbox work.
8. Use **Open Customer** when the conversation changes an order, pickup, alteration, shipment, or wedding party plan.

## Operational detail

Use this inbox to decide who needs a response, not to replace the Customer Hub. A recent message without a linked customer should be handled carefully: search the customer first, confirm phone or email ownership, then create or link a contact only when staff can identify the person.

The screen refreshes the Riverside copy every minute while it is open. Podium webhooks are still the fastest path for new inbound messages; Riverside stores verified webhook events in a retryable queue before acknowledging them. **Refresh** reloads only the Riverside copy. Open **Status** for provider diagnostics and **Pull from Podium** when history is missing. The pull uses Podium's cursor-paged conversation and message APIs, and Riverside also runs it in the background when history is more than 30 minutes old. **History current** appears only after every matched conversation history in the pull is stored. If the Inbox reports **History incomplete**, retry the pull once and escalate the displayed failure if it remains.

Under **Unknown Podium senders**, choose **Match customer**, search for the intended existing customer, confirm the phone/email belongs to that person, and select the record. When multiple customers share an identifier, Riverside labels the collision and refuses to choose silently. The resolution is stored against the exact Podium conversation ID and later synchronization clears the item from the unmatched queue.

## Tips

- Use this list to triage communication work quickly from either shell.
- Riverside replies already carry the signed-in Riverside staff member. Replies and assignments created in Podium use the manager-maintained Podium-to-staff link.
- A Podium alert names the customer; opening its message item takes you to that customer's conversation in this inbox. Older stored alerts use the customer match to find the latest thread.
- If you need the full customer record, open the row instead of trying to work from the list alone.
- **ROS webhook ready** means Riverside has its local signing secret and inbound processing enabled. The provider subscription can still require an update; Settings → Integrations → Podium is authoritative for that status.
- **History current** means the last matched conversation histories completed. **History incomplete** means at least one history is missing, failed, or due for a provider pull.
- A collision warning means staff must verify identity; do not select a customer solely because they are the newest record.

## What happens next

After a row opens, continue in the selected inbox conversation. Use **Open Customer** for notes or follow-up tasks when the conversation changes the customer's order, appointment, wedding party, alteration, or pickup plan. If the message belongs to a new number, collect first and last name before creating a new contact.


## Escalation

Escalate when a message includes payment disputes, return promises, customer-data corrections, angry language, or a request that affects a wedding party, pickup, alteration, or shipment timeline. Staff should not promise refunds, delivery dates, or account corrections from the inbox row alone.


If the customer identity is uncertain, ask for enough detail to match an existing customer before linking the thread.

## Related workflows

- [Customers Workspace](manual:customers-workspace)
- [Customer Relationship Hub](manual:customers-customer-relationship-hub-drawer)
