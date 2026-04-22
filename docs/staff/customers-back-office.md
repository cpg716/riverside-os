# Customers (Back Office)

**Audience:** Sales and CRM staff.

**Where in ROS:** Back Office → **Customers**. Subsections: **All Customers**, **Add Customer**, **RMS charge** (linked accounts plus R2S/CoreCard **charge** vs **payment** ledger; needs **`customers.rms_charge.view`** or legacy **`customers.rms_charge`**), **Duplicate review** (queue inbox; needs **`customers_duplicate_review`**).

**Related permissions:** Browse/search/create use general customer access. The **Relationship hub** and aligned APIs use **fine-grained keys** (migration **63**): **`customers.hub_view`**, **`customers.hub_edit`**, **`customers.timeline`**, **`customers.measurements`**, plus **`orders.view`** for the **Orders** tab. An **open register** session can satisfy the same checks as staff with those keys for many calls — see **[`../CUSTOMER_HUB_AND_RBAC.md`](../CUSTOMER_HUB_AND_RBAC.md)** and **[`../STAFF_PERMISSIONS.md`](../STAFF_PERMISSIONS.md)**. **Joint Couple Accounts** (link/unlink partners) require **`customers.couple_manage`**. **Duplicate review queue** and **Merge** (two customers selected) need **`customers_duplicate_review`** and **`customers.merge`** respectively; migration **64** grants both to default **`salesperson`** and **`sales_support`** roles. **403** on a specific hub action usually means a **missing key**, not a bug.

---

## How to use this area

**All Customers** is the **searchable directory**. **Add Customer** opens the **drawer** form. The **Relationship hub** is the customer review drawer for profile details, messages, measurements, orders, shipments, and weddings. If you **cannot open** the hub, you likely lack **`customers.hub_view`**. If a **tab is missing**, your role may not include **`orders.view`**, **`shipments.view`**, or **`customers.measurements`**. If you can open the hub but **cannot edit** marketing/VIP/profile fields, you may lack **`customers.hub_edit`**. **Timeline** read/write needs **`customers.timeline`**.

## All Customers

1. **Customers** → **All Customers**.
2. **Search** — name, phone digits, **customer_code**, or email fragment per field behavior.
3. Use **Load more** at the bottom for large result sets.
4. Click a row → **hub** opens.

### Relationship hub tabs

- **Profile** — the main customer review tab. Use it for customer notes, contact details, VIP flag, joint account linkage, and overall account context. This is also where staff can see store credit, deposit waiting, loyalty points, and active wedding linkage.
- **Messages** — Podium message review and follow-up when available.
- **Transactions** — customer sale history.
- **Orders** — order-linked history and handoff into the Back Office Orders workflow.
- **Shipments** — customer shipment history and shipment drill-in (**`shipments.view`**).
- **Measurements** — sizing vault (**`customers.measurements`**); **PII** — verify identity before reading aloud.
- **Weddings** — wedding party linkage and wedding shortcuts.

### Relationship hub versus RMS Charge

- Use the **Relationship hub** to understand the customer record.
- Use **RMS Charge** to manage RMS-linked accounts, RMS transaction posting, RMS exceptions, and RMS reconciliation.
- Do not treat the Relationship hub as the place to resolve RMS financing issues. It provides customer context, not the full RMS support workflow.

**Add Customer** after save: **VIP** on create and **initial note** only apply if you have **`customers.hub_edit`** and **`customers.timeline`** respectively; otherwise the app shows a **toast** and still creates the customer.

## Add Customer

1. **Customers** → **Add Customer** (sidebar or workspace button).
2. Complete **required** fields; **customer_code** is usually **server-assigned** on create — do not invent duplicate codes.
3. **Save**; read **toast**. Fix **red** inline validation first.
4. Closing the drawer from the sidebar shortcut returns to **All Customers**.

## RMS charge (linked accounts and reporting)

1. **Customers** → **RMS charge** (if your role includes **`customers.rms_charge.view`** or legacy **`customers.rms_charge`**).
2. Select a customer to review any linked CoreCredit/CoreCard accounts. Account cards show **masked** account ids, status, program group, and last verification timestamp.
3. If your role also includes **`customers.rms_charge.manage_links`**, you can manually **link** or **unlink** an account from this workspace.
4. Use the records table to reconcile **R2S** activity with the portal:
   - **charge** rows now read as **RMS Charge** and can show program/account metadata
   - **payment** rows still come from register **PAYMENT** → **RMS CHARGE PAYMENT** checkouts (**cash/check**)
   - Phase 3 adds operational **Overview**, **Accounts**, **Transactions**, **Programs**, **Exceptions**, and **Reconciliation** sections with sync health and retry tools
5. Exception queue and reconciliation actions require RMS operational permissions such as **`customers.rms_charge.resolve_exceptions`**, **`customers.rms_charge.reconcile`**, and **`customers.rms_charge.reporting`**.
6. In the Back Office workspace:
   - `Exceptions` is the staff ownership queue for assign / retry / resolve work
   - `Reconciliation` is a global RMS support review tab and is not filtered to only the customer currently selected
7. Resolution notes should explain what cleared the issue instead of using a generic close-out.
8. In `Accounts`, use `Remove Link` only to correct the Riverside customer relationship to an RMS account. The confirmation step explains that CoreCard itself is not changed and the correction is logged.
9. Live RMS refund/reversal actions are manager/admin-sensitive and should only be used by approved staff with the required permissions.
10. Start with the role-based RMS manuals:
   - **[RMS Charge overview](rms-charge-overview.md)**
   - **[RMS Charge accounts](rms-charge-accounts.md)**
   - **[RMS Charge transactions](rms-charge-transactions.md)**
   - **[RMS Charge exceptions](rms-charge-exceptions.md)**
   - **[RMS Charge reconciliation](rms-charge-reconciliation.md)**
11. Use **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)** when you need deeper engineering detail about APIs, persistence, or accounting support behavior.

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
| Hub tab missing | **`orders.view`** / **`customers.measurements`** / role default | **Staff → User overrides** or manager |
| “No permission to open the customer hub” | Missing **`customers.hub_view`** | Manager / **`permissions-and-access.md`** |
| Timeline hidden or “no permission” | Missing **`customers.timeline`** | Manager |
| Cannot edit marketing or VIP | Missing **`customers.hub_edit`** | Manager |

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
