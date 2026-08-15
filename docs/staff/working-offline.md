# Working offline (staff summary)

**Audience:** Floor staff and managers.

**Where in ROS:** Mostly **POS**; Back Office needs connectivity for most actions.

**Related permissions:** Unchanged offline; queued actions still respect your role when they sync.

---

## How to use this guide

Read this **before** a storm or ISP outage. Know what you **can** promise customers and what requires **manager** approval when sync returns.

## What still works

- Only a **simple take-now sale** paid with cash, a physical check, or a verified **Manual Card** approval completed outside ROS can queue while the device is offline. ROS prints **SALE SAVED - PENDING SYNC** with a recovery number. This is not yet a Main Hub Transaction Record; give the receipt to the customer and do not ring the sale again.
- A card cannot be newly approved while Helcim or the internet is unavailable. But if Helcim already approved a **simple take-now** sale and the Main Hub drops before the save finishes, select the green **Ready to Save** box once. ROS prints a **PAYMENT APPROVED - PENDING SYNC** receipt and posts the same checkout automatically after reconnecting. Do not run the card again. This does not apply to shipping, pickup, orders, exchanges, alterations, or wedding work.
- When Riverside shows **Pending syncs**, those are completed POS sales still waiting to post once the device is back online.
- If a sync cannot be safely replayed, Riverside keeps it as **blocked recovery** for manager review. Do not clear browser storage, refresh aggressively, or ring the same sale again.
- **Do not** promise **inventory** or **pickup** dates you cannot verify live unless SOP says otherwise.

## What does not

- Live **inventory** checks, **wedding** ledger updates, and **QBO** actions need the server.
- Shipping, Fulfillment Orders, order payments, weddings, pickups, alterations, returns/exchanges, gift cards, deposits, Store Credit/account tenders, tax-exempt sales, backdated sales, and below-cost approvals do not queue offline.
- A red **Server connection lost** banner does not enable ordinary offline checkout while the device still reports online. Keep the sale open until the Main Hub returns; only an exact already-approved Helcim take-now payment has the protected Pending Sync path.
- **Back Office** heavy workflows (imports, backups, schedule edits) expect a stable connection.
- Seeing the PWA shell open offline does **not** mean the whole app is safe to use offline.

## Practical tips

- Watch for **toast** errors after actions; if something “saved” locally, confirm it appears on **another device** or **Back Office** after reconnect.
- On iPhone-class screens, Riverside may shorten the top-bar status to **Offline** or **1 sync** so the message stays readable without horizontal scrolling.
- Write **paper backup** of high-value transactions if your SOP requires when offline mode misbehaves.

## Helping a customer during an outage

1. **Be honest:** “Our system is slow; I can ring you but fulfillment may need confirmation.”
2. **Do not** invent **stock** counts — offer **call-back** when online.
3. For **wedding** deadlines same week, get a **manager** on the phone.

## Helping a coworker

- If they are **retrying** the same payment: stop them — note **time** and **amount**, then **one** supervised retry per SOP.
- If **Back Office** works but **POS** does not (or the reverse): note **which URL/app** — helps IT isolate **API** vs **client**.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Sales stuck “pending sync” | Wait; move device to stronger Wi‑Fi | Manager — do not double-charge |
| Checkout recovery needs review | Stop duplicate attempts and call a manager | Manager reviews/retries/exports; if it remains open, close normally and verify it remains visible in the operational recovery workspace |
| Duplicate charge fear | Compare **receipt #** on paper vs screen | Orders lead |
| “Online only” error on BO | Expected | Wait for network |
| Tailscale down | Check phone **cellular** | See [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) |

## When to get a manager

- **Any** customer dispute about **whether payment posted**.
- Outage **longer than SOP threshold** (e.g. 30 minutes).
- Checkout recovery remains unclear after review. Assign an owner before handoff; the authorized ordinary close remains available and records the exact warning on the Z-Report without resolving it.

---

## See also

- [../OFFLINE_OPERATIONAL_PLAYBOOK.md](../OFFLINE_OPERATIONAL_PLAYBOOK.md)
- [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) — full Tailscale setup
- [`REMOTE_ACCESS_USER_GUIDE.md`](../REMOTE_ACCESS_USER_GUIDE.md) — concept and roles

**Last reviewed:** 2026-07-26
