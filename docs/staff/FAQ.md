# FAQ (intent map for staff help)

Short answers point to **one** deeper page — avoid conflicting guidance. For definitions, see [GLOSSARY.md](GLOSSARY.md). For HTTP and toasts, see [ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md).

---

## Sign-in and access

**I don’t see a sidebar tab my coworker has.**  
Usually **permissions**. [permissions-and-access.md](permissions-and-access.md)

**I get 403 when I save.**  
Permission on that **action**, not the whole tab. [ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md) and [permissions-and-access.md](permissions-and-access.md)

**POS says I need a register session.**  
Open the register per SOP. [register-tab-back-office.md](register-tab-back-office.md), [00-getting-started.md](00-getting-started.md)

---

## POS, Register (cart), and checkout

**Complete Sale is grayed out.**  
[ERROR-AND-TOAST-GUIDE.md](ERROR-AND-TOAST-GUIDE.md) → symptom table; detail: [pos-register-cart.md](pos-register-cart.md)

**I know the customer / SKU / party, but not which section to open.**  
[universal-search.md](universal-search.md)

**Search finds nothing.**  
Use **SKU** first; POS Inventory needs **2+** search characters. [pos-register-cart.md](pos-register-cart.md), [pos-inventory.md](pos-inventory.md)

**How do wedding party payments split?**  
[abstracts/wedding-group-pay.md](abstracts/wedding-group-pay.md) and [pos-weddings.md](pos-weddings.md)

---

## Inventory and stock

**What does “reserved” mean?**  
[GLOSSARY.md](GLOSSARY.md) → **Reserved stock**; behavior: [abstracts/special-orders-and-stock.md](abstracts/special-orders-and-stock.md)

**Special order pickup — do we pull from the floor immediately?**  
Not always — stock model differs from carry-out. [abstracts/special-orders-and-stock.md](abstracts/special-orders-and-stock.md)

**Receiving and POs — where?**  
Back Office [inventory-back-office.md](inventory-back-office.md). Quick add-from-browse at POS: [pos-inventory.md](pos-inventory.md)

---

## Orders, returns, refunds

**Refund vs void — which doc?**  
[abstracts/returns-refunds-exchanges.md](abstracts/returns-refunds-exchanges.md) → then [orders-back-office.md](orders-back-office.md)

---

## Weddings and appointments

**Weddings tab missing.**  
**weddings.view** — [permissions-and-access.md](permissions-and-access.md)

**Store calendar vs wedding party.**  
[appointments.md](appointments.md), [weddings-back-office.md](weddings-back-office.md)

**Action Board shows a balance line for a party.**  
Server **`party_balance_due`** on **`GET /api/weddings/actions`** — [weddings-back-office.md](weddings-back-office.md)

---

## Customers and CRM

**Relationship Hub won’t open or I get 403 inside it.**  
Hub tabs use **`customers.hub_view`**, **`hub_edit`**, **`timeline`**, **`measurements`**; **Orders** needs **`orders.view`**. [customers-back-office.md](customers-back-office.md), [permissions-and-access.md](permissions-and-access.md). Engineers: [../CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md).

---

## Tasks, schedule, notifications

**My tasks list is empty but manager says I have tasks.**  
Lazy materialization — open **My tasks** once. [pos-tasks.md](pos-tasks.md), [staff-administration.md](staff-administration.md)

**Bell / notifications.**  
[operations-home.md](operations-home.md), [pos-dashboard.md](pos-dashboard.md). **Many alerts in one row?** Open the bell and **tap the row** to expand bundled items (then tap a line to jump to that SKU, task, PO, etc.).

---

## Gift cards and loyalty

**Card not found at POS but shows in Back Office.**  
[gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md)

---

## Settings, backups, weather

**Receipt time wrong.**  
Timezone in **Settings → General**. [settings-back-office.md](settings-back-office.md)

---

## Offline and outages

**Can we sell when Wi‑Fi drops?**  
[working-offline.md](working-offline.md) and [../OFFLINE_OPERATIONAL_PLAYBOOK.md](../OFFLINE_OPERATIONAL_PLAYBOOK.md)

---

## Store-specific rules (hours, who approves voids)

**Admins:** enter them in **Settings → General → Store staff playbook** (live in the database). **Everyone:** the repo file [STORE-SOP-TEMPLATE.md](STORE-SOP-TEMPLATE.md) is only an outline to copy from; trainers and AI tools should prefer **`GET /api/staff/store-sop`** when the user is signed in so answers match what the store actually saved.

---

## Release & stability notes

**Did anything in checkout or POS steps change in the post-v0.1.9 hotfix?**  
No day-to-day cashier workflow changed. The hotfix focused on backend/CI stability (server compile checks, SQL query metadata sync, lint gate hardening), not new POS steps.

**Why did we ship this if staff behavior did not change?**  
To reduce deployment failures and prevent hidden backend regressions before code reaches the floor. This improves release reliability without changing your normal actions in Register, Orders, or Customers.

**Should I retrain staff for this hotfix?**  
No retraining needed. Continue using existing SOPs. If you see unusual behavior, submit an in-app bug report with the screen, time, and what you expected to happen.

---

**Last reviewed:** 2026-04-11
