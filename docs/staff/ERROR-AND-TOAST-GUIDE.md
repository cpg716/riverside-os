# Errors, toasts, and HTTP codes

ROS uses **toasts** and **modals** for feedback — not browser `alert`, `confirm`, or `prompt`. This page maps **what staff see** to **what to do first**.

---

## Read the toast before tapping away

- **Green / success:** confirm the action matches what you intended (correct customer, correct order).
- **Red / error:** read the **first line**; often it names the field or permission.
- If the toast disappears, reproduce once and watch carefully, or ask a coworker to watch.

---

## By HTTP status (API)

| Code | Usually means | First steps |
|------|----------------|------------|
| **401** | Not signed in, invalid staff/POS headers, or stale register token after a reset | Back Office: sign out and sign in again; hard refresh if it persists. POS: complete register open flow; if IT reloaded the database, open the register again. |
| **403** | **Permission denied** — your role cannot do this | Do not retry blindly. Manager: **Role access**, **User overrides**, or correct workflow (e.g. refund vs view). [permissions-and-access.md](permissions-and-access.md) |
| **404** | Missing record **or** “no active session” | Back Office with a **closed** till: **404** on session reads can be normal. **POS / Register:** open a till session if checkout-related. Deep link: stale ID — navigate from list again. |
| **409** | Conflict — duplicate action, state changed | Refresh the order or list; one supervised retry. |
| **422** | Validation — bad input | Fix red fields; read server message for which field. |
| **429** | Rate limit | Slow down automated retries; wait a minute. |
| **500 / 502 / 503** | Server or upstream failure | **One** refresh; if repeated, stop money actions and escalate with **time** and **what you clicked**. |

---

## By symptom (plain language)

| Symptom | Likely cause | First steps |
|---------|----------------|------------|
| “Network error” / fetch failed | Offline, DNS, VPN, Tailscale | Check Wi‑Fi; [working-offline.md](working-offline.md) |
| “Permission” / 403 on save | Missing key for that action | Compare to [permissions-and-access.md](permissions-and-access.md); manager adjusts role |
| “Recalc” / totals error | Lines changed while saving | Refresh order; avoid editing same order in two tabs |
| Complete Sale disabled | Validation: customer required, zero line, modal open | Read on-screen hint; [pos-register-cart.md](pos-register-cart.md) |
| Blank list after search | Query too short (e.g. POS Inventory needs **2+** characters) | Type more characters; [pos-inventory.md](pos-inventory.md) |
| Stuck on “connecting” (card) | Terminal simulation or gateway delay | Wait full timeout once; one retry; then SOP |
| Duplicate charge worry | Double tap or retry | Compare receipt numbers; manager — do not run a third tender unsupervised |

---

## Modals

- **Confirmation:** read **title** and **body**; financial modals are intentional friction.
- **Prompt:** type carefully; PIN and override entry is audited on sensitive paths.

---

## When to escalate

- Any **money** action that fails twice with different errors.
- **403** on a task your SOP says you should perform (role misconfiguration).
- **500** during **refund**, **void**, or **payout** finalize.

---

## See also

- [FAQ.md](FAQ.md)
- [00-getting-started.md](00-getting-started.md)
- [working-offline.md](working-offline.md)

**Last reviewed:** 2026-04-04
