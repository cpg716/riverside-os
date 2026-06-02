---
id: customers-podium-messaging-inbox-section
title: "Podium Inbox"
order: 1007
summary: "Review shared Podium SMS and email threads from Operations or POS, then open the full conversation in the Customer Hub."
source: client/src/components/customers/PodiumMessagingInboxSection.tsx
last_scanned: 2026-06-02
tags: customers, podium, messaging, inbox, communications
---

# Podium Inbox

## Screenshots

![Customers workspace](../images/help/customers-workspace/main.png)

![Orders workspace](../images/help/orders-workspace/main.png)

![Wedding lookup drawer](../images/help/pos/wedding-lookup-drawer.png)

## What this is

Podium Inbox is the shared list of recent Podium SMS and email conversations.

In Operations and POS, this surface is for communications follow-up only. It is not a general task inbox.

## How to use it

1. Open **Operations** → **Podium Inbox** or **POS** → **Podium Inbox**.
2. Review the most recent customer conversation rows.
3. Open a row to read and reply in the thread.
4. Use **Open Customer** when the conversation changes an order, pickup, alteration, shipment, or wedding party plan.

## Operational detail

Use this inbox to decide who needs a response, not to replace the Customer Hub. A recent message without a linked customer should be handled carefully: search the customer first, confirm phone or email ownership, then create or link a contact only when staff can identify the person.

The screen refreshes the Riverside copy every minute while it is open. Podium webhooks are still the fastest path for new inbound messages; **Pull from Podium** fills missed history. Riverside also runs a background Podium pull every 30 hours by default when Podium is configured. If the inbox looks stale, check the **Inbox updating** row before assuming there are no current conversations.

## Tips

- Use this list to triage communication work quickly from either shell.
- If you need the full customer record, open the row instead of trying to work from the list alone.
- **Webhook ready** means new Podium messages can arrive by event.
- **Missed-history pull current** means the local fallback pull is within the expected window.

## What happens next

After a row opens, continue from the full customer conversation. Add notes or follow-up tasks in the customer workflow when the conversation changes the customer's order, appointment, wedding party, alteration, or pickup plan. If the message belongs to a new number, collect first and last name before creating a new contact.


## Escalation

Escalate when a message includes payment disputes, return promises, customer-data corrections, angry language, or a request that affects a wedding party, pickup, alteration, or shipment timeline. Staff should not promise refunds, delivery dates, or account corrections from the inbox row alone.


If the customer identity is uncertain, ask for enough detail to match an existing customer before linking the thread.

## Related workflows

- [Customers Workspace](manual:customers-workspace)
- [Customer Relationship Hub](manual:customers-customer-relationship-hub-drawer)
