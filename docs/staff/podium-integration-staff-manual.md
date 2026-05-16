# Podium integration (staff manual)

**Audience:** **All staff** who message customers, complete sales, or watch notifications; **admins** who turn Podium on and edit templates.

**Where in ROS:** **Settings → Integrations → Podium**; **Operations → Podium Inbox**; **POS → Podium Inbox**; Relationship Hub **Messages**; **POS** receipt summary; **Operations → Reviews**; **Notification Center** (new SMS).

**Related permissions:** If a screen is missing, ask a manager to check **Staff → Team** (role or overrides). Detail: [STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md), [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md).

**Full reference (same topic, more depth):** [Podium_Integration_Manual.md](Podium_Integration_Manual.md). Engineers: [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md).

---

## What this is for

**Podium** is the store’s link between Riverside OS and **customer texting, review invites, and optional web chat**. Store email is handled by the ROS first-party IONOS mailbox. When IT has configured Podium and an admin has enabled it in Settings, Riverside can:

- Send **automatic** texts (e.g. pickup ready, alteration ready) using your wording.
- Let staff **reply** to customers from the **customer profile** without opening Podium’s full Inbox.
- Send a **manual text** from **Podium Inbox** to an existing customer or a new phone number.
- Send **text receipts** from the POS using the standard receipt content.
- Show **new customer texts** as **notifications** you can open into the right profile.

This guide is **how to work in Riverside**. It does not replace Podium’s own help site or your store’s legal/consent policies.

---

## How to use the main surfaces

| Surface | What you should see | Main actions |
|---------|---------------------|--------------|
| **Settings → Integrations → Podium** | Readiness line, toggles, templates, widget box | Admins: turn channels on, edit templates, **Save**; **Connect Podium** when IT says to refresh the token. |
| **Operations → Podium Inbox** | Send Text composer, unmatched Podium queue, recent threads | Send a text to a current customer or a new phone number; open a row → customer hub; **Refresh** if the list looks stale. |
| **POS → Podium Inbox** | Same shared inbox inside the POS shell | Send a text without leaving POS; open a row → POS Customers with **Messages** focused. |
| **Customer hub → Messages** | Thread + compose | Read history; send **SMS**; optional Podium conversation **URL** field for deep links. |
| **POS → Receipt summary** | Text receipt and review controls | Send text receipt if the customer wants it; optional **review invite** checkbox per store defaults. |
| **Notification Center** | “New customer SMS” rows | Open item → deep link toward **Customers** / **Messages** when configured. |

---

## Common tasks

### Admin: confirm Podium is ready (no messages sending)

1. Sign in with a role that can open **Settings** → **Integrations**.
2. Open **Podium (SMS + web chat)**.
3. Check the **readiness** strip: credentials, webhook (IT), **location UID** filled in, and **SMS Active** as your SOP requires.
4. If the card says **credentials missing**, an admin can save or update the Podium credentials in this Settings screen. Use **Authorize via Podium Portal** / **Connect Podium** only after both **Client ID** and **Client Secret** are saved and the redirect URI is registered in Podium.

### Admin / IT: know which Podium values to enter

- **Client ID** and **Client Secret** come from the Podium developer app.
- **Refresh Token** is normally saved automatically after **Authorize via Podium Portal** succeeds; do not ask staff to find or paste it.
- **API Host** is normally `https://api.podium.com`.
- **OAuth Token URL** is normally `https://api.podium.com/oauth/token`.
- **Webhook URL** must be the public Riverside endpoint, not `localhost`. For the current store tunnel use `https://ros.riversidemens.com/api/webhooks/podium`.
- **Webhook Signing Secret** is saved after the webhook is registered. It lets Riverside verify Podium deliveries before they enter the inbox.

If the authorization page says the Client ID and redirect URI do not match, register the exact callback URL shown in Riverside on the same Podium app as the saved Client ID, then start authorization again.

### Admin: change pickup or alteration message wording

1. **Settings** → **Integrations** → **Podium**.
2. Edit the text message template you need. Use the template tag buttons for customer/order values such as **First name** or **Transaction**.
3. Click **Save Podium / messaging settings** and wait for the success toast.

### Staff: reply to a customer by SMS from their profile

1. **Customers** → search → open the customer → **Relationship Hub**.
2. Open the **Messages** tab.
3. Type the reply and send via **SMS** (customer must have a **phone** on file).
4. Confirm the toast (e.g. sent via Podium). If you see a **502** or “Podium unavailable,” tell a manager—sends are blocked upstream.

**Permission:** **`customers.hub_edit`** (and hub view). If the tab is missing, you have view-only or no hub access.

### Staff: use the SMS inbox list

1. **Operations** → **Podium Inbox**.
2. Use **Send Text** to search/select a current customer or enter a phone number.
3. If the phone number is not already a customer, enter the customer’s **first** and **last** name before sending. Riverside creates the new contact and records the outbound message.
4. Find an existing thread; click to open their profile / hub.
5. Use **Refresh** after you know a new message arrived if the row does not update. Refresh asks Podium for the current conversation list and brings back multiple pages when needed, so recent provider conversations should not be hidden behind old synced rows.

**Permission:** Viewing requires **`customers.hub_view`**. Sending or creating the new contact requires **`customers.hub_edit`**.

### Staff: use the SMS inbox list from POS

1. **POS** → **Podium Inbox**.
2. Use **Send Text** for a current customer or a new phone number. New phone numbers require first and last name before sending.
3. Review the shared thread list without leaving the register shell.
4. Open a row to switch into **POS → Customers** with the customer **Messages** tab focused.

**Permission:** **`customers.hub_view`**.

### Cashier: text a receipt after sale

1. Complete checkout until **Receipt summary** appears.
2. Choose **text receipt** as your SOP allows.
3. If store email is needed, use the ROS Mailbox / IONOS email workflow instead of Podium Settings.

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
- **“This person is not in ROS yet.”** Use **Podium Inbox → Send Text**, enter the phone number plus first and last name, and send once. Riverside creates the contact with Podium as the source so staff can complete or merge it later.
- **“Notification won’t open the right person.”** Ask them to use **Podium Inbox** or search the customer by name/code, then open **Messages** manually; IT verifies **webhook** configuration if links are consistently wrong.
- **Never** paste Podium **secrets**, **refresh tokens**, or **webhook signing keys** into chat or bug reports—only managers/IT handle those on the server.

---

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| **403 / no Podium card** | Sign in as admin or ask for **settings.admin** | Manager adjusts role |
| **Podium page says "Client ID is required"** | Return to Settings, confirm **Client ID** is saved, and start authorization again from the Podium card | Manager / IT checks the saved credentials and redirect URI |
| **Podium page says Client ID and redirect URI do not match** | Stop and check the callback URL registered in Podium | IT updates the Podium developer app to match Riverside exactly |
| **Podium consent page says something went wrong** | Do not retry repeatedly; check whether the Podium app has message/location/review scopes enabled | IT / Podium support |
| **No Messages tab** | Confirm **Relationship Hub** access | [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md) |
| **Send Text button stays disabled** | Add message text; for new numbers add phone, first name, and last name | Manager checks **customers.hub_edit** |
| **Send failed / Podium unavailable** | Readiness + toggles + location UID | Manager / IT |
| **Automated SMS never fires** | Customer **opt-in** + valid phone + template not empty | Admin + [Podium_Integration_Manual.md](Podium_Integration_Manual.md) |
| **Inbound customer texts never appear** | Confirm the public webhook URL is registered and tunnel/public host is running | IT checks webhook secret/signature and event types |
| **Podium Inbox shows old conversations but not current Podium rows** | Click **Sync Podium** / **Refresh** once and confirm the Settings card still says credentials configured | IT checks OAuth scopes, location UID, provider cursor sync, and whether Podium returned the expected conversation page |
| **Store email fails** | IONOS mailbox settings, customer email, server logs | Settings admin |
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

- [Podium_Integration_Manual.md](Podium_Integration_Manual.md) — full capability list, Settings credential flow, webhook checklist.
- [settings-back-office.md](settings-back-office.md) — Settings tabs overview.
- [customers-back-office.md](customers-back-office.md) — Customers workspace.
- [pos-register-cart.md](pos-register-cart.md) — Register and receipt flow.
- [operations-home.md](operations-home.md) — Operations home and Reviews.

**Last reviewed:** 2026-05-16
