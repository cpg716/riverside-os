---
id: customers-workspace
title: "Customer CRM Hub"
order: 1030
summary: "Manage client relationships, track lifetime sales, monitor wedding party membership, and handle technical CRM tasks like duplicate merging."
source: client/src/components/customers/CustomersWorkspace.tsx
last_scanned: 2026-04-17
tags: customers, crm, relationships, hub, measurements, timeline, merge, rms
---

# Customers (Back Office)

_Audience: Sales and CRM staff._

**Where in ROS:** Back Office → **Customers**. Subsections: **All Customers**, **Add Customer**, **RMS charge**, **Duplicate review**.

---

## How to use this area

**All Customers** is the **searchable directory**. **Add Customer** opens the **drawer** form. The **Relationship Hub** (slideout drawer) is the core of the CRM, containing:

## All Customers Search

1. **Customers** → **All Customers**.
2. **Search** — name, phone digits, **customer_code**, or email fragment.
3. Use **Load more** at the bottom for large result sets.
4. Click a row to open the **Relationship Hub**.

## Add Customer

1. **Customers** → **Add Customer**.
2. Complete **required** fields; **customer_code** is automatically server-assigned on create.
3. **Save** and verify the success toast. Fix **red** inline validation if saving fails.

## Relationship Hub Tabs

- **Relationship**: Marketing opt-ins, **interaction timeline**, and partner linking (**Joint Couple Accounts**). Contact details (phone, email, address) are prominently displayed at the top of this tab for quick access. With `shipments.view` permission, shipping updates are automatically linked here.
- **Joint Couple Accounts**: Link a partner (existing or new) for combined spend and loyalty views.
- **Measurements**: Sizing vault for fittings. Always verify identity before reading aloud as this contains PII.
- **Card Vault**: Securely manage Stripe card-on-file tokens. ROS only stores the last 4 digits and brand.
- **Duplicate Review & Merge**: If two customers are selected, use the **Merge** tool to consolidate profiles. This uses the emerald "Finalize" button style to indicate a destructive action.

## RMS Charge (Admin)

1. **Customers** → **RMS charge**.
2. Use this to reconcile **R2S activity** with the internal ledger.
3. **Charge** rows come from POS RMS tenders; **Payment** rows come from register `RMS CHARGE PAYMENT` checkouts.

## Troubleshooting

| Symptom                       | Action                                                                |
| :---------------------------- | :-------------------------------------------------------------------- |
| **Search yields no results**  | Try phone number digits or a shorter name fragment.                   |
| **"No permission" toast**     | Check your role for `customers.hub_view` or `customers.timeline`.     |
| **Tab missing in Hub**        | Typically means `orders.view` or `customers.measurements` is missing. |
| **Cannot edit VIP/Marketing** | Requires `customers.hub_edit` permission.                             |
| **Contact info not showing**  | Verify customer profile has phone/email/address populated in backend. |

**Last reviewed:** 2026-04-17
