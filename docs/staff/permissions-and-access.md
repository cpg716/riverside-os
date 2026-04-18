# Permissions and access (plain language)

**Audience:** All staff; admins for changes.

**Where in ROS:** Controlled by the server. You **see** only sidebar tabs and subsections your **effective permissions** allow.

**Related permissions:** This article explains the idea; the full key list is in [STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md).

---

## How to use this guide

When someone says **“I don’t have that button,”** work through:

1. Are they signed into **Back Office** (not guest browser)?
2. Is the **tab** missing or only a **subsection** (e.g. **Physical count**)?
3. Does the error say **403** on save? That is almost always **permission**, not a bug.

## Why a tab or button is missing

Riverside OS hides **entire tabs** or **subsections** when your role does not include the required **permission key**. Examples:

| If you cannot see… | Typical permission involved |
|--------------------|-----------------------------|
| **Staff** tab | **staff.view** |
| **QBO bridge** | **qbo.view** |
| **Orders** | **orders.view** |
| **Weddings data / wedding reads** | **weddings.view** |
| **Wedding Manager shell** | **wedding_manager.open** |
| **Alterations** | **alterations.manage** |
| **Gift Cards** | **gift_cards.manage** |
| **Settings** (most tabs) | **settings.admin** |
| **Settings → Online store** | **online_store.manage** (admins also have access) |
| **Appointments** | **weddings.view** (shared with wedding reads) |
| **Loyalty** (any of Eligible / Adjust / Settings) | **loyalty.program_settings** and/or **loyalty.adjust_points** |
| **Staff → Commission payouts** (finalize payout runs) | **insights.commission_finalize** |
| **Inventory → Physical count** | **physical_inventory.view** |
| **Staff → Team** (Edit staff → **Access** checklist) | **staff.manage_access** |
| **Settings → Staff access defaults** | **settings.admin** **or** **staff.manage_access** |
| **Staff → Tasks** (subsection) | **tasks.complete** (templates may need **tasks.manage**) |
| **Staff → Team** (Edit staff → **PIN**) | **staff.manage_pins** |
| **Staff → Commission** | **staff.manage_commission** |
| **Staff → Audit** | **staff.view_audit** |
| **POS Alterations** rail item | **alterations.manage** |
| **Customers → Relationship hub** (open drawer) | **customers.hub_view** |
| **Hub** — edit marketing, VIP, profile fields | **customers.hub_edit** |
| **Hub** — timeline + **add note** | **customers.timeline** |
| **Hub** — **Measurements** tab | **customers.measurements** |
| **Customers → RMS charge** (R2S ledger report) | **customers.rms_charge** |
| **Hub** — **Orders** tab (history) | **orders.view** |
| **Staff → Team** (+ Add Staff / link profile) | **staff.edit** |
| **Pick which register to attach to** when several are open; **list open registers** for satellite link | **register.session_attach** (see **[Till group / lanes](../TILL_GROUP_AND_REGISTER_OPEN.md)** and **[STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)**) |

**Admin role:** In software, **admin** is treated as having the **full permission catalog** so a mis-seeded role row cannot lock out the store.

## Helping a coworker

1. **Reproduce** on their login — not yours.
2. Open **Staff → Team** (if you have access) → confirm their **role**.
3. Compare to table above.
4. If they **should** have access, open **Staff → Team** → **Edit** their profile → **Access** (requires **staff.manage_access**) or confirm **Settings → Staff access defaults** if the whole role template is wrong.

## Per-person access

Managers edit **individual permission keys** on **Staff → Team → Edit staff → Access** (**staff.manage_access**). **Store templates** (**Settings → Staff access defaults**) plus **Apply role defaults** on a profile reset a person to their role’s template without changing other people.

## Till session vs Back Office only

- **Back Office sign-in** (Staff select + 4-digit PIN) gates most tabs.
- An **open till** (register session) is still required for **checkout** and some **session-tied** reads even if you are signed into Back Office. Enter **POS** from the sidebar, then open or join a lane per SOP.

## Manager Overrides (PIN Bypass)

Riverside OS uses **Role-Based Authorization** to reduce friction for administrators while maintaining security for other staff.

1. **Role Bypass**: If you are signed in with an **Admin** role, the system recognizes your authority. You will automatically bypass manual PIN prompts for sensitive actions like **Void All**, **Large Discounts**, or **Commission Correction**.
2. **One-Time Authorization**: For non-admins, these actions trigger the **Manager Approval Modal**. Any manager or admin can step in, select their identity from the dropdown, and enter their PIN to authorize that specific action. 
3. **Implicit Auditing**: Every authorization is recorded in the **Staff Access Log** with a timestamp, the identifying manager, the specific action taken (e.g., `pos_price_override`), and context like the cart subtotal or discount percentage. 
4. **No Session Change**: Providing an approval PIN does **not** sign the manager in; it only authorizes the single requested action for the active cashier.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Tab visible yesterday, gone today | **Role** or **override** changed | Admin reviews **Audit** |
| **403** on one action only | Sub-permission (e.g. refund vs view) | [orders-back-office.md](orders-back-office.md) |
| Manager cannot lock out admin | By design — admin full catalog | Owner changes role in DB / policy |
| POS sees different menu than BO | Extra **session** checks | [pos-register-cart.md](pos-register-cart.md) |

## When to get a manager

- Any request for **customer PII** export you are not cleared for.
- **Suspected** permission escalation (staff asking for **audit** casually).

---

## See also

- [00-getting-started.md](00-getting-started.md)
- [../STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)

**Last reviewed:** 2026-04-04
