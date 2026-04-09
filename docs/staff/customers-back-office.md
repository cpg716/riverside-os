# Customers (Back Office)

**Audience:** Sales and CRM staff.

**Where in ROS:** Back Office → **Customers**. Subsections: **All Customers**, **Add Customer**, **RMS charge** (R2S **charge** vs **payment** ledger; needs **`customers.rms_charge`**), **Duplicate review** (queue inbox; needs **`customers_duplicate_review`**).

**Related permissions:** Browse/search/create use general customer access. The **Relationship hub** and aligned APIs use **fine-grained keys** (migration **63**): **`customers.hub_view`**, **`customers.hub_edit`**, **`customers.timeline`**, **`customers.measurements`**, plus **`orders.view`** for the **Orders** tab. An **open register** session can satisfy the same checks as staff with those keys for many calls — see **[`../CUSTOMER_HUB_AND_RBAC.md`](../CUSTOMER_HUB_AND_RBAC.md)** and **[`../STAFF_PERMISSIONS.md`](../STAFF_PERMISSIONS.md)**. **Duplicate review queue** and **Merge** (two customers selected) need **`customers_duplicate_review`** and **`customers.merge`** respectively; migration **64** grants both to default **`salesperson`** and **`sales_support`** roles. **403** on a specific hub action usually means a **missing key**, not a bug.

---

## How to use this area

**All Customers** is the **searchable directory**. **Add Customer** opens the **drawer** form. The **Relationship hub** (drawer) holds **Relationship** (marketing pulse, **timeline**, **add note**, weddings list), **Measurements**, **Orders**, and **Profile** tabs. If you **cannot open** the hub, you likely lack **`customers.hub_view`**. If a **tab is missing**, your role may not include **`orders.view`** or **`customers.measurements`**. If you can open the hub but **cannot edit** marketing/VIP/profile fields, you may lack **`customers.hub_edit`**. **Timeline** read/write needs **`customers.timeline`**.

## All Customers

1. **Customers** → **All Customers**.
2. **Search** — name, phone digits, **customer_code**, or email fragment per field behavior.
3. Use **Load more** at the bottom for large result sets.
4. Click a row → **hub** opens.

### Relationship hub tabs (typical)

- **Relationship** — marketing opt-ins (needs **`customers.hub_edit`** to toggle), **interaction timeline** and **add note** (**`customers.timeline`**; timeline also lists **shipping** updates from the shipment log when that customer has shipments — with **`shipments.view`**, click a shipping line to open that shipment on the **Shipments** tab), past weddings shortcuts.
- **Measurements** — sizing vault (**`customers.measurements`**); **PII** — verify identity before reading aloud.
- **Profile** — customer code (read-only), optional duplicate-review queue (**`customers_duplicate_review`**), VIP flag and profile details (**`customers.hub_edit`** to save), contact/address display.
- **Orders** — paged order history (**`orders.view`**); **Open** jumps to Back Office **Orders** when wired.

**Add Customer** after save: **VIP** on create and **initial note** only apply if you have **`customers.hub_edit`** and **`customers.timeline`** respectively; otherwise the app shows a **toast** and still creates the customer.

## Add Customer

1. **Customers** → **Add Customer** (sidebar or workspace button).
2. Complete **required** fields; **customer_code** is usually **server-assigned** on create — do not invent duplicate codes.
3. **Save**; read **toast**. Fix **red** inline validation first.
4. Closing the drawer from the sidebar shortcut returns to **All Customers**.

## RMS charge (admin reporting)

1. **Customers** → **RMS charge** (if your role includes **`customers.rms_charge`**).
2. Set **from** / **to** dates and optional filters (**kind** = charge vs payment, **customer**, text **search**).
3. Use the table to reconcile **R2S** activity with the portal: **charge** rows come from **RMS/RMS90** tenders on sales; **payment** rows come from register **PAYMENT** → **RMS CHARGE PAYMENT** checkouts (**cash/check**).
4. Technical reference: **[Parked sales and RMS charges](../POS_PARKED_SALES_AND_RMS_CHARGES.md)**.

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

**Last reviewed:** 2026-04-05
