# Podium integration (staff manual)

**Audience:** **All staff** who message customers, complete sales, or watch notifications; **admins** who turn Podium on and edit templates.

**Where in ROS:** **Settings → Integrations → Podium**; **Operations → Podium Inbox**, Relationship Hub **Messages**; **POS** receipt summary; **Operations → Reviews**; **Notification Center** (new SMS/email).

**Related permissions:** If a screen is missing, ask a manager to check **Staff → Team** (role or overrides). Detail: [STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md), [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md).

**Full reference (same topic, more depth):** [Podium_Integration_Manual.md](Podium_Integration_Manual.md). Engineers: [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md).

---

## What this is for

**Podium** is the store’s link between Riverside OS and **customer texting, email, and optional web chat**. When IT has configured the server and an admin has enabled it in Settings, Riverside can:

- Send **automatic** texts/emails (e.g. pickup ready, alteration ready) using your wording.
- Let staff **reply** to customers from the **customer profile** without opening Podium’s full Inbox.
- Send **email / text receipts** from the POS when Receipt Builder is set up.
- Show **new customer texts/emails** as **notifications** you can open into the right profile.

This guide is **how to work in Riverside**. It does not replace Podium’s own help site or your store’s legal/consent policies.

---

## How to use the main surfaces

| Surface | What you should see | Main actions |
|---------|---------------------|--------------|
| **Settings → Integrations → Podium** | Readiness line, toggles, templates, widget box | Admins: turn channels on, edit templates, **Save**; **Connect Podium** when IT says to refresh the token. |
| **Operations → Podium Inbox** | List of recent threads | Open a row → customer hub; **Refresh** if the list looks stale. |
| **Customer hub → Messages** | Thread + compose | Read history; send **SMS** or **email** (subject required for email); optional Podium conversation **URL** field for deep links. |
| **POS → Receipt summary** | Email / text receipt buttons | Send receipt if the customer wants it; optional **review invite** checkbox per store defaults. |
| **Notification Center** | “New customer SMS” / email rows | Open item → deep link toward **Customers** / **Messages** when configured. |

---

## Common tasks

### Admin: confirm Podium is ready (no messages sending)

1. Sign in with a role that can open **Settings** → **Integrations**.
2. Open **Podium (SMS + web chat)**.
3. Check the **readiness** strip: credentials, webhook (IT), **location UID** filled in, and **Send operational SMS** / **email** toggles as your SOP requires.
4. If the card says **credentials missing**, you cannot fix that in the UI—**IT** sets server environment variables. Use **Connect Podium** only after IT says the app is registered and secrets are in place.

### Admin: change pickup or alteration message wording

1. **Settings** → **Integrations** → **Podium**.
2. Edit the **SMS** template(s) or **email** subject/HTML blocks you need.
3. Click **Save Podium / messaging settings** and wait for the success toast.

### Staff: reply to a customer by SMS from their profile

1. **Customers** → search → open the customer → **Relationship Hub**.
2. Open the **Messages** tab.
3. Type the reply and send via **SMS** (customer must have a **phone** on file).
4. Confirm the toast (e.g. sent via Podium). If you see a **502** or “Podium unavailable,” tell a manager—sends are blocked upstream.

**Permission:** **`customers.hub_edit`** (and hub view). If the tab is missing, you have view-only or no hub access.

### Staff: reply by email from the profile

1. Same hub → **Messages**.
2. Fill **subject** and message body (HTML where the form allows).
3. Send. Customer must have **email** on file.

### Staff: use the SMS & email inbox list

1. **Operations** → **Podium Inbox**.
2. Find the customer; click to open their profile / hub.
3. Use **Refresh** after you know a new message arrived if the row does not update.

**Permission:** **`customers.hub_view`**.

### Cashier: email or text a receipt after sale

1. Complete checkout until **Receipt summary** appears.
2. Choose **email receipt** and/or **text receipt** as your SOP allows.
3. If email fails with a message about **Receipt Builder** or empty template, the store has not saved receipt HTML—manager or **Settings → Receipt Builder**.

Details: [RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md).

### Cashier: post-sale review invite (checkbox)

1. On **Receipt summary**, use your store’s **review invite** control (send vs skip) exactly as trained.
2. The register records your choice; **Operations → Reviews** can list what was sent or skipped. Live delivery through Podium’s review product may still be on IT’s roadmap—see manager if unsure.

### Manager: check review invite history

1. **Operations** → **Reviews** (subsection).
2. Scan **sent** vs **suppressed** timestamps; open the order in Back Office from the row if needed.

**Permission:** **`reviews.view`**.

---

## Helping a coworker or customer

- **“Customer says they never got the text.”** Check **profile**: phone number, **operational** / **marketing** SMS flags per store policy; confirm the order actually hit **pickup ready** (or the right trigger). Escalate if templates or Podium toggles are wrong—do not spam resends without manager approval.
- **“Notification won’t open the right person.”** Ask them to use **Customers → inbox** and search by name or code from the notification text; IT verifies **webhook** configuration if links are consistently wrong.
- **Never** paste Podium **secrets**, **refresh tokens**, or **webhook signing keys** into chat or bug reports—only managers/IT handle those on the server.

---

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| **403 / no Podium card** | Sign in as admin or ask for **settings.admin** | Manager adjusts role |
| **No Messages tab** | Confirm **Relationship Hub** access | [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md) |
| **Send failed / Podium unavailable** | Readiness + toggles + location UID | Manager / IT |
| **Automated SMS never fires** | Customer **opt-in** + valid phone + template not empty | Admin + [Podium_Integration_Manual.md](Podium_Integration_Manual.md) |
| **Receipt email fails** | Receipt Builder exported HTML saved | Settings admin |
| **Widget missing on public site** | Not a cashier task—**IT** + storefront flags | [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md) |

---

## When to get a manager

- Any **payment** or **refund** dispute tied to “they said they got a text.”
- **Consent** questions (marketing vs transactional SMS/email).
- **Suspected duplicate customers** after an unknown number texted in.
- **Repeated** Podium or **502** errors after one retry.
- **Webhook** or **OAuth** errors called out on the Integrations card.

---

## See also

- [Podium_Integration_Manual.md](Podium_Integration_Manual.md) — full capability list, env vars, webhook checklist.
- [settings-back-office.md](settings-back-office.md) — Settings tabs overview.
- [customers-back-office.md](customers-back-office.md) — Customers workspace.
- [pos-register-cart.md](pos-register-cart.md) — Register and receipt flow.
- [operations-home.md](operations-home.md) — Operations home and Reviews.

**Last reviewed:** 2026-04-08
