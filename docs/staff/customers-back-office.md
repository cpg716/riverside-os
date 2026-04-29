# Customers (Back Office)

**Audience:** Sales and CRM staff.

**Where in ROS:** Back Office → **Customers**. Subsections: **All Customers**, **Add Customer**, **Layaways** (all-customer layaway workspace), **Shipments Hub** (all-customer shipping workspace), **RMS Charge** (all-customer private-label credit workspace), and **Duplicate Review** (all-customer profile review queue).

**Related permissions:** Browse/search/create use general customer access. Some hub tabs and customer-related workspaces are role-limited. If a tab or action is missing, ask a manager to review your customer, Orders, Shipping, RMS Charge, or Duplicate Review access.

---

## How to use this area

**All Customers** is the **searchable directory**. **Add Customer** opens the **drawer** form. The **Relationship hub** is scoped to the customer you opened: use it for this customer’s profile, messages, measurements, TRX records, ORD fulfillment work, shipments, weddings, and related history. The sidebar workspaces are broader queues or operational tools across customers.

## All Customers

1. **Customers** → **All Customers**.
2. **Search** — name, phone digits, **customer_code**, or email fragment per field behavior.
3. Use **Load more** at the bottom for large result sets.
4. Click a row → **hub** opens.

### Relationship hub tabs

- **Profile** — this customer’s contact details, notes, VIP flag, joint account linkage, store credit/deposit context, loyalty points, and active wedding linkage.
- **Messages** — this customer’s Podium message thread and follow-up when available.
- **TRX Records** — this customer’s financial sale records.
- **ORD Work** — this customer’s Special, Custom, or Wedding fulfillment work and handoff into the Back Office Orders workflow.
- **Shipments** — this customer’s shipment history and shipment drill-in.
- **Measurements** — this customer’s sizing records; **PII** — verify identity before reading aloud.
- **Wedding Links** — this customer’s wedding party linkage and wedding shortcuts.

### Relationship hub versus RMS Charge

- Use the **Relationship hub** for this customer’s RMS Charge context and related customer history.
- Use **RMS Charge** for all-customer account review, posting status, exceptions, and reconciliation.
- Do not treat the Relationship hub as the global RMS Charge support workflow.

**Add Customer** after save: **VIP** on create and **initial note** only apply when your role can edit customer profiles and notes; otherwise the app shows a message and still creates the customer.

## Add Customer

1. **Customers** → **Add Customer** (sidebar or workspace button).
2. Complete **required** fields; **customer_code** is usually **server-assigned** on create — do not invent duplicate codes.
3. Watch the **Customer match review** area. If a matching name exists, enter a phone number first. If the phone does not match, review same-name profiles by **Name**, **Phone**, **Email**, and **Address** before creating a new record; update the existing profile when it is the same person with changed contact details.
4. For mailing address, start typing **Address line 1**. If suggestions appear, select the correct one to fill **Address line 1**, **City**, **State**, and **Postal code**. If no suggestion appears or the lookup is unavailable, keep typing the address manually; customer save should not depend on address lookup.
5. **Save**; read **toast**. Fix **red** inline validation first.
6. Closing the drawer from the sidebar shortcut returns to **All Customers**.

The same Add Customer intake is used from POS when staff search by a name, phone, or email that does not exist. The same address behavior is used in the Relationship hub **Profile** tab: suggested addresses are a helper only, and manual entry remains valid.

## RMS Charge (linked accounts and reporting)

1. **Customers** → **RMS Charge**.
2. Use customer lookup to review linked RMS Charge accounts. Account cards show masked account ids, status, program group, and last verification timestamp.
3. If your role allows it, you can manually **link** or **unlink** an account from this workspace.
4. Use the records table to reconcile RMS Charge activity with the portal:
   - **Charge** rows show RMS Charge activity and account details.
   - **Payment** rows come from register **PAYMENT** → **RMS CHARGE PAYMENT** checkouts (**cash/check**).
   - **Overview**, **Accounts**, **Transactions**, **Programs**, **Exceptions**, and **Reconciliation** are all-customer RMS Charge support sections.
5. Exception queue and reconciliation actions require RMS operational access.
6. In the Back Office workspace:
   - **Exceptions** is the staff ownership queue for assign / retry / resolve work.
   - **Reconciliation** is a global RMS support review tab and is not filtered to only the customer currently selected.
7. Resolution notes should explain what cleared the issue instead of using a generic close-out.
8. In `Accounts`, use `Remove Link` only to correct the Riverside customer relationship to an RMS account. The confirmation step explains that CoreCard itself is not changed and the correction is logged.
9. Live RMS refund/reversal actions are manager/admin-sensitive and should only be used by approved staff with the required permissions.
10. Start with the role-based RMS manuals:
   - **[RMS Charge overview](rms-charge-overview.md)**
   - **[RMS Charge accounts](rms-charge-accounts.md)**
   - **[RMS Charge transactions](rms-charge-transactions.md)**
   - **[RMS Charge exceptions](rms-charge-exceptions.md)**
   - **[RMS Charge reconciliation](rms-charge-reconciliation.md)**
11. Use **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)** for the RMS Charge payment workflow.

## Groups and imports

- **Customer groups** / **VIP** bulk actions may live on list or **hub** — follow **manager** training.
- **Lightspeed import** and **merge** are **admin** workflows — see [CUSTOMERS_LIGHTSPEED_REFERENCE.md](../CUSTOMERS_LIGHTSPEED_REFERENCE.md).
- **Merge** confirm uses the **emerald** “terminal completion” button style (same family as **Complete Sale** / **Post inventory**) so destructive commits are visually consistent with other **finalize** actions.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Search empty | Shorter term; **Load more** | Typo |
| Drawer won’t save | Scroll to first error | Network |
| Duplicate warning | Search existing | Manager **merge** |
| Hub tab missing | Role does not include that customer area | Manager |
| “No permission to open the customer hub” | Customer profile access missing | Manager |
| Timeline hidden or “no permission” | Notes/history access missing | Manager |
| Cannot edit marketing or VIP | Profile edit access missing | Manager |

## Helping a coworker

- Confirm **which** customer when **similar names** — use **phone last 4** + **code**.

## When to get a manager

- **Merge** or **delete** requests.
- **Legal** name / **ID** verified changes.

---

## See also

- [../CUSTOMERS_LIGHTSPEED_REFERENCE.md](../CUSTOMERS_LIGHTSPEED_REFERENCE.md)
- [../SEARCH_AND_PAGINATION.md](../SEARCH_AND_PAGINATION.md)

**Last reviewed:** 2026-04-09 (Joint accounts added)
