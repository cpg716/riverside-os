# Working offline (staff summary)

**Audience:** Floor staff and managers.

**Where in ROS:** Mostly **POS**; Back Office needs connectivity for most actions.

**Related permissions:** Unchanged offline; queued actions still respect your role when they sync.

---

## How to use this guide

Read this **before** a storm or ISP outage. Know what you **can** promise customers and what requires **manager** approval when sync returns.

## What still works

- **Checkout queue** and similar offline-tolerant flows (see operational playbook) may let you **capture** sales when the API is temporarily unreachable, then **sync** when the connection returns.
- When Riverside shows **Pending syncs**, those are completed POS sales still waiting to post once the device is back online.
- **Do not** promise **inventory** or **pickup** dates you cannot verify live unless SOP says otherwise.

## What does not

- Live **inventory** checks, **wedding** ledger updates, and **QBO** actions need the server.
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
| Duplicate charge fear | Compare **receipt #** on paper vs screen | Orders lead |
| “Online only” error on BO | Expected | Wait for network |
| Tailscale down | Check phone **cellular** | [REMOTE_ACCESS_GUIDE](../../REMOTE_ACCESS_GUIDE.md) owner |

## When to get a manager

- **Any** customer dispute about **whether payment posted**.
- Outage **longer than SOP threshold** (e.g. 30 minutes).

---

## See also

- [../OFFLINE_OPERATIONAL_PLAYBOOK.md](../OFFLINE_OPERATIONAL_PLAYBOOK.md)
- [../../REMOTE_ACCESS_GUIDE.md](../../REMOTE_ACCESS_GUIDE.md)

**Last reviewed:** 2026-04-04
