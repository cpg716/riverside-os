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
2. Use the conversation search and the **Open**, **Needs reply**, **Unread**, or **Closed** filter to find the conversation. Messages from phone numbers or email addresses that are not in Riverside appear in this same list as **Unknown sender**.
3. Open a row to read and reply in the text-style thread. Opening the row marks that conversation read.
4. Use **Mark unread** when another staff member still needs to review the conversation. Use row checkboxes to mark several conversations read or unread together.
5. Use **Close** to move a conversation into Podium's closed/archive state. Find it under **Closed** and choose **Reopen** when follow-up resumes. Group Close/Reopen reports partial provider failures.
6. Check **In conversation** for the assigned staff. Linked Riverside names appear in green; **Not linked** means a manager must connect that Podium identity under **Staff → Team → Edit → Linked Podium Staff Member**.
7. Choose **New message** only when starting a separate text; the customer/phone form stays hidden during normal inbox work.
8. Use **Open Customer** when the conversation changes an order, pickup, alteration, shipment, or wedding party plan.
9. For an unknown sender, choose **Match Customer** to connect an existing record or **Add Customer** to create a reviewed customer record with the sender's phone number or email prefilled. The conversation stays visible whether or not staff connect it.

## Operational detail

Use this inbox to decide who needs a response, not to replace the Customer Hub. Riverside stores messages from unknown or ambiguous senders without silently creating or choosing a customer. Search first, confirm phone or email ownership, then match or add the customer only when staff can identify the person.

The screen refreshes the Riverside copy every minute while it is open. Podium webhooks are still the fastest path for new inbound messages; Riverside stores verified webhook events in a retryable queue before acknowledging them. **Refresh** reloads only the Riverside copy. Open **Status** for provider diagnostics and **Pull from Podium** when history is missing. The pull uses Podium's cursor-paged conversation and message APIs, and Riverside also refreshes provider history in the background when the last pull is more than 30 minutes old. A routine background refresh is not an error. **History current** appears when the recent provider-backed conversations have stored history. If the Inbox reports **History incomplete**, retry the pull once and escalate the displayed failure if it remains.

## Tips

- Use this list to triage communication work quickly from either shell.
- Riverside replies already carry the signed-in Riverside staff member. Replies and assignments created in Podium use the manager-maintained Podium-to-staff link.
- A matched Podium alert names the customer; an unknown-sender alert still opens the exact conversation. Older stored alerts use the customer match to find the latest thread.
- If you need the full customer record, open the row instead of trying to work from the list alone.
- **ROS webhook ready** means Riverside has its local signing secret and inbound processing enabled. The provider subscription can still require an update; Settings → Integrations → Podium is authoritative for that status.
- **History current** means recent provider-backed conversation histories completed. **History incomplete** means at least one recent history is missing or failed; it does not merely mean the next routine refresh is due.
- When search returns more than one plausible customer, verify the phone or email owner; do not select a record solely because it is newest.

## What happens next

After a row opens, continue in the selected inbox conversation. Use **Open Customer** for notes or follow-up tasks when the conversation changes the customer's order, appointment, wedding party, alteration, or pickup plan. If the message belongs to a new number, collect first and last name before creating a new contact.


## Escalation

Escalate when a message includes payment disputes, return promises, customer-data corrections, angry language, or a request that affects a wedding party, pickup, alteration, or shipment timeline. Staff should not promise refunds, delivery dates, or account corrections from the inbox row alone.


If the customer identity is uncertain, ask for enough detail to match an existing customer before linking the thread.

## Related workflows

- [Customers Workspace](manual:customers-workspace)
- [Customer Relationship Hub](manual:customers-customer-relationship-hub-drawer)
