---
id: customers-workspace
title: "Customers Workspace"
order: 1005
summary: "Review customer accounts, open the relationship hub, and use the right workspace for customer history versus RMS support."
source: client/src/components/customers/CustomersWorkspace.tsx
last_scanned: 2026-06-02
tags: customers, support, relationships, duplicate-review
---

# Customers Workspace

## Screenshots

![Customers workspace](../images/help/customers-workspace/workflow-1.png)

![Add Customer drawer](../images/help/customers-workspace/workflow-2.png)

![Duplicate Review queue](../images/help/customers-workspace/workflow-3.png)
## What this is

Use this workspace to:

- search for a customer by name, phone, email, or customer code
- review customer-level status such as weddings, open balance, and recent activity
- open the `Customer Relationship Hub` drawer for profile, message, measurement, shipment, and order review
- move into a more specialized workflow like `RMS Charge` or `Duplicate Review` when needed

## What the main list tells you

Each customer row is a quick support summary. Staff can usually see:

- customer name and code
- lifecycle state such as `New`, `Pending`, `Pickup`, or `Issue`
- contact information
- lifetime sales
- open balance
- whether the customer is tied to an active wedding party

This list helps you decide which customer to open. It is not the full support record by itself.
Normal customer search and browse results show active profiles. Inactive profiles from duplicate cleanup or import repair are kept for audit/history but are not offered for normal customer selection.
Customers with an active linked RMS Charge account or a match in the latest weekly RMS account list show an **RMS Charge** pill. The pill is a quick account-presence signal; open the customer relationship hub or RMS Charge workspace to review balances, account details, and reporting status.

The workspace now also shows a `Customer Completeness` summary above the list. That summary uses the same existing profile-complete expectation already used elsewhere in Riverside: a complete customer profile has both a phone number and an email address. Use it to spot records that may block future receipt, pickup, or follow-up work.

## What belongs here versus RMS Charge

Use the main Customers workspace and relationship hub when you need to review:

- customer profile details
- notes and timeline history. Order history should show the booked Transaction Record, payment events, and pickup or shipment events as separate facts.
- measurements
- Transaction Records and fulfillment-order history
- shipment history
- wedding linkage

Use `RMS Charge` when you need to:

- verify a linked RMS account
- review RMS-specific posting history
- work RMS exceptions
- review RMS reconciliation

The relationship hub supports customer review. The RMS workspace supports financing account operations.

## How to use it

1. Search for the correct customer first.
2. Use **Add Customer** when the person is not already in Riverside. Enter name and contact details first, then start typing the U.S. street address and select the correct suggestion to fill address line 1, address line 2 when available, city, state, and ZIP. Western New York matches rank first, out-of-state matches remain available, and every filled field stays editable. Email, SMS, operational SMS, and operational email approvals start checked for a new account; review them with the customer and uncheck any approval they do not give before saving.
3. Use the lifecycle filter when you need to isolate new customers, active follow-up, ready pickups, completed history, or issues.
4. Open the customer row to review the relationship hub.
5. Use the relationship hub tabs for profile, orders, messages, measurements, weddings, and shipments.
6. Use **Duplicate Review** when Riverside flags likely duplicate customer records.
   Choose the record with the most complete measurements, alterations, balances, relationships, and operational history as the master. The master keeps its existing profile values and fills blank contact details, address fields, dates, and other profile details from the duplicate. Riverside blocks the merge when deleting the other record could remove or detach linked history; follow the reason shown before trying again.
7. Return to the main workspace if you need a different customer.
8. Move to `RMS Charge` only when the question is about RMS financing accounts or RMS support follow-up.

## Related sections

- `Duplicate Review`
  Use when two customer records may need merge review.
- `RMS Charge`
  Use when the issue is about a linked RMS financing account, RMS payment history, or RMS support operations.

## Tips

- Start with the active Riverside customer profile, not a name-only match.
- Use phone, customer code, and wedding context to confirm the right record before taking action.
- Customer search accepts initials or partial fragments from both names in either order, such as `C Garcia`, `Ch Gar`, or `Gar C`, as well as a full name and phone digits even when the stored phone uses different punctuation. Confirm phone, email, customer code, or wedding context before selecting a similar name. Use **Load more records** when the matching customer is not on the first page.
- Riverside waits for a short pause in typing before it searches. Existing rows stay visible but dimmed while the latest results load; wait for **Updating customer results** to clear before treating the list as the latest match set.
- A blocked merge is a data-protection stop, not a failed search. Keep the record named by the linked-history warning as the master, or resolve the listed link in its normal workspace before merging.
- When adding a customer, keep the required identity/contact fields complete before moving to optional preferences. The four contact approvals are prechecked for new accounts but remain editable before save.
- If the issue is financing-specific, do not try to solve it from the relationship hub alone. Open `RMS Charge`.
- A `Profile incomplete` chip on the browse row means the record is missing either phone or email, even if the rest of the account looks active.
