# Podium integration (staff manual)

**Audience:** **All staff** who message customers, complete sales, or watch notifications; **admins** who turn Podium on and edit templates.

**Where in ROS:** **Settings → Integrations → Podium** (connection, location, webhooks, and Podium SMS); **Settings → Customer Reviews**; **Settings → Email**; **Settings → Receipt Settings**; **Settings → Online Store** (web chat); **Operations → Podium Inbox**; **POS → Podium Inbox**; Relationship Hub **Messages**; **Operations → Reviews**; **Notification Center** (new SMS).

**Related permissions:** If a screen is missing, ask a manager to check **Staff → Team** (role or overrides). Detail: [STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md), [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md).

**Engineering reference:** [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md).

---

## What this is for

**Podium** is the store’s link between Riverside OS and **customer texting, review invites, and optional web chat**. Podium delivers review-request email; other Store Email is handled by the ROS first-party IONOS mailbox. When IT has configured Podium and an admin has enabled it in Settings, Riverside can:

- Send **automatic** texts (e.g. pickup ready, alteration ready) using your wording.
- Let staff **reply** to customers from the **customer profile** without opening Podium’s full Inbox.
- Send a **manual text** from **Podium Inbox** to an existing customer or a new phone number.
- Send **text receipts** from the POS using the standard receipt content.
- Keep each setting with its owner: Podium SMS under **Podium**, operational email under **Email**, review policy and wording under **Customer Reviews**, receipt delivery under **Receipt Settings**, and web chat under **Online Store**.
- Show **new customer texts** as **notifications** you can open into the right profile.
- **Match staff to Podium users** so messages show real names, not UUIDs.
- **Sync customers to Podium contacts** automatically and on demand from the Customer Hub.

This guide is **how to work in Riverside**. It does not replace Podium’s own help site or your store’s legal/consent policies.

---

## How to use the main surfaces

| Surface | What you should see | Main actions |
|---------|---------------------|--------------|
| **Settings → Integrations → Podium** | OAuth setup, provider location list, webhook subscription state, Podium SMS controls | Admins: connect/reconnect, select the location, register/update the webhook, edit Podium SMS, and run diagnostics. |
| **Settings → Customer Reviews** | Review policy and Podium review-request wording | Admins: control the global/default policy and edit review SMS/email wording. |
| **Settings → Email** | IONOS mailbox plus operational email wording | Admins: configure Store Email and pickup/alteration/appointment email templates. |
| **Settings → Receipt Settings** | Receipt layout plus digital delivery wording | Admins: edit the receipt itself, receipt email subjects, Podium MMS captions, and the text-receipt switch. |
| **Settings → Online Store** | Storefront setup and Podium web chat | Admins: enable the widget and paste the exact Podium-provided snippet. |
| **Staff → Edit** | Podium user dropdown | Managers with `staff_edit`: link each staff member to their Podium user identity. |
| **Operations → Podium Inbox** | Conversation list, message thread, reply composer, Send Text composer, unmatched Podium queue, assignee display | Read the thread, reply in context, open the customer record, send a text to a current customer or a new phone number, and **Refresh** if the list looks stale. |
| **POS → Podium Inbox** | Same shared inbox inside the POS shell | Read/reply without leaving POS; open the customer record when the conversation needs profile or order follow-up. |
| **Customer hub → Messages** | Thread + compose + contact sync | Read history; send **SMS**; optional Podium conversation **URL** field for deep links; **Sync to Podium Contacts** button. |
| **POS → Receipt summary** | Text receipt and automatic review status | Send a text receipt if the customer wants it; confirm eligible review follow-up is scheduled for five days after fulfillment. |
| **Notification Center** | “New customer SMS” rows | Open item → deep link toward **Customers** / **Messages** when configured. |

---

## Common tasks

### Admin: confirm Podium is ready (no messages sending)

1. Sign in with a role that can open **Settings** → **Integrations**.
2. Open **Podium**.
3. Check the readiness values: saved credentials, pinned API version, signing-secret state, inbound processing, and the individual text-message toggles required by your SOP.
4. If the card says **credentials missing**, an admin can save or update the Podium credentials in this Settings screen. Use **Authorize via Podium Portal** / **Connect Podium** only after both **Client ID** and **Client Secret** are saved and the redirect URI is registered in Podium.
5. Ensure the Podium app has all required scopes enabled: `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `read_contacts`, and `write_contacts`. Existing connections must use **Reconnect Podium Account** once after `read_contacts` is enabled.
6. Select the correct active location from the provider-backed **Podium location** list and save it. Do not type or copy a raw location UID.
7. Save a webhook signing secret, then use **Register Webhook**. Riverside creates or updates only the subscription matching its public HTTPS URL and selected location, for the message, contact, and review-link events it processes.
8. Use **Check Health**, then **Reconcile Contacts** under **Diagnostics and contact maintenance**. Reconciliation compares the complete Podium contact list and shows collisions that require staff review. Riverside allows one reconciliation at a time and stops safely if Podium returns an incomplete or unrecognized contact page.

### Admin / IT: know which Podium values to enter

- **Client ID** and **Client Secret** come from the Podium developer app.
- **Refresh Token** is normally saved automatically after **Authorize via Podium Portal** succeeds; do not ask staff to find or paste it.
- **API Host** is normally `https://api.podium.com`.
- **OAuth Token URL** is normally `https://api.podium.com/oauth/token`.
- **Webhook URL** must be the public Riverside endpoint, not `localhost`. For the current store tunnel use `https://ros.riversidemens.com/api/webhooks/podium`.
- **Webhook Signing Secret** is saved before **Register Webhook** and sent to Podium during registration. Riverside uses the same value to verify every delivery before it enters the queue.

If the authorization page says the Client ID and redirect URI do not match, register the exact callback URL shown in Riverside on the same Podium app as the saved Client ID, then start authorization again.

### Manager: link staff to Podium users

1. **Staff → Team** → open a staff member → **Edit**.
2. In the **Podium User** section, use the dropdown to select the matching Podium user. The list loads from Podium's `/v4/users` API.
3. Save. Messages from that staff member will now show their real name instead of a UUID.

### Admin: edit customer message wording

1. Use the page that owns the message:
   - **Settings → Podium** for staff-authored and automated Podium text workflows.
   - **Settings → Email** for operational Store Email subjects and bodies.
   - **Settings → Customer Reviews** for review policy and Podium review SMS/email.
   - **Settings → Receipt Settings** for text-receipt enablement, MMS captions, and receipt email subjects.
   - **Settings → Online Store** for the Podium web-chat embed.
2. Enable only the workflows the store wants. Text workflows remain independent.
3. Leave a wording field blank to inherit the centrally maintained Riverside default. Use **Use Riverside Defaults** to remove an override.
4. Keep `{review_url}` in custom review message bodies.
5. Save that section and wait for the success toast. New sends use the saved wording; already-sent messages do not change.

### Staff: reply to a customer by SMS from their profile

1. **Customers** → search → open the customer → **Relationship Hub**.
2. Open the **Messages** tab.
3. Type the reply and send via **SMS** (customer must have a **phone** on file).
4. Confirm the toast (e.g. sent via Podium). If you see a **502** or “Podium unavailable,” tell a manager—sends are blocked upstream.

**Permission:** **`customers.hub_edit`** (and hub view). If the tab is missing, you have view-only or no hub access.

### Staff: sync a customer to Podium contacts

1. Open a customer → **Relationship Hub**.
2. In the **Communication preferences** section, click **Sync to Podium Contacts**.
3. Riverside pushes the customer's name, phone, and email to Podium (create or update). The status below the button shows the provider contact ID, last success, retry attempt, or terminal error.
4. Automatic sync uses the same durable queue and retries up to eight times. Do not repeatedly click the button while a retry is already pending.

ROS is still the appointment system of record. Podium sends enabled appointment confirmations, reminders, and calendar attachments; staff book and update the appointment only in **Back Office → Appointments** or the linked Wedding workflow.

### Staff: use the SMS inbox list

1. **Operations** → **Podium Inbox**.
2. Use the left conversation list to select a customer thread. The message thread opens on the right with customer and Riverside replies separated like a text conversation.
3. Reply from the composer at the bottom of the open thread. Email replies require a subject; SMS replies do not.
4. Use **Open Customer** when the conversation needs profile, transaction, fulfillment, or wedding follow-up.
5. Use **Send Text** when you need to start a new staff-initiated text. Search/select a current customer or enter a phone number.
6. If the phone number is not already a customer, enter the customer’s **first** and **last** name before sending. Riverside creates the new contact and records the outbound message.
7. The thread auto-scrolls to the newest message; outbound messages show a **Sent** badge and the sender's name.
8. The conversation header shows **assigned Podium users** when available.
9. Use **Refresh** after you know a new message arrived if the row does not update. Refresh asks Podium for the current conversation list and brings back multiple pages when needed, so recent provider conversations should not be hidden behind old synced rows.
10. Use **Unknown Podium senders** only when matching provider threads to customers. Choose **Match customer**, search for the intended customer, verify identity, and select that record. The decision is audited against the exact provider conversation ID.
11. When the card says multiple customers share the identifier, correct the duplicate phone/email data or deliberately choose the intended record. Riverside never silently chooses the newest customer.

**Permission:** Viewing requires **`customers.hub_view`**. Sending or creating the new contact requires **`customers.hub_edit`**.

### Staff: use the SMS inbox list from POS

1. **POS** → **Podium Inbox**.
2. Select a customer thread, read the message history, and reply from the conversation composer without leaving the register shell.
3. Use **Open Customer** when the message requires a profile, order, fulfillment, or wedding lookup.
4. Use **Send Text** for a current customer or a new phone number. New phone numbers require first and last name before sending.

**Permission:** **`customers.hub_view`**.

### Cashier: text a receipt after sale

1. Complete checkout until **Receipt summary** appears.
2. Choose **text receipt** as your SOP allows.
3. If store email is needed, use the ROS Mailbox / IONOS email workflow instead of Podium Settings.

Details: [RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md).

### Cashier: post-sale review invite

1. Eligible fulfilled/picked-up Transactions enter the review schedule automatically. Staff do not choose which individual customers are asked.
2. Riverside rechecks non-internal line fulfillment, customer contact information, the **180-day** cadence, the store enable switch, and the customer review opt-out before delivery.
3. The request is sent at **10:00 AM five days after fulfillment** (Monday when the fifth day is Sunday), using Podium text when a usable phone exists or Podium email when email is the only usable destination.
4. **Operations → Reviews** lists scheduled, sent, failed, and suppressed outcomes. Closing or auto-closing the receipt cannot lose the scheduled request.

### Manager: check review invite history

1. **Operations** → **Reviews** (subsection).
2. Scan **scheduled**, **sent**, **failed**, and **suppressed** rows; correct the displayed contact/integration problem before using **Retry** on a failed row, or open the Transaction Record in Back Office.

**Permission:** **`reviews.view`**.

---

## Helping a coworker or customer

- **“Customer says they never got the text.”** Check **profile**: phone number, **operational** / **marketing** SMS flags per store policy; confirm the fulfillment work actually hit **pickup ready** (or the right trigger). Escalate if templates or Podium toggles are wrong—do not spam resends without manager approval.
- **“This person is not in ROS yet.”** Use **Podium Inbox → Send Text**, enter the phone number plus first and last name, and send once. Riverside creates the contact with Podium as the source so staff can complete or merge it later.
- **“Notification won’t open the right person.”** Ask them to use **Podium Inbox** or search the customer by name/code, then open **Messages** manually; IT verifies **webhook** configuration if links are consistently wrong.
- **“The customer texted STOP.”** Riverside disables marketing and operational SMS only for an exact recognized opt-out command such as `STOP`, `UNSUBSCRIBE`, or `OPT OUT`. A sentence that merely contains the word “stop” does not change consent.
- **Never** paste Podium **secrets**, **refresh tokens**, or **webhook signing keys** into chat or bug reports—only managers/IT handle those on the server.

---

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| **403 / no Podium card** | Sign in as admin or ask for **settings.admin** | Manager adjusts role |
| **Podium page says "Client ID is required"** | Return to Settings, confirm **Client ID** is saved, and start authorization again from the Podium card | Manager / IT checks the saved credentials and redirect URI |
| **Podium page says Client ID and redirect URI do not match** | Stop and check the callback URL registered in Podium | IT updates the Podium developer app to match Riverside exactly |
| **Podium consent page says something went wrong** | Do not retry repeatedly; check whether the Podium app has all scopes enabled (`read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `read_contacts`, `write_contacts`) | IT / Podium support |
| **Contact reconciliation reports conflicts** | Review the named contact and candidate count; correct duplicate phone/email data in Podium or Customer Hub, then reconcile again | Manager / IT; never guess between customers |
| **No Messages tab** | Confirm **Relationship Hub** access | [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md) |
| **Send Text button stays disabled** | Add message text; for new numbers add phone, first name, and last name | Manager checks **customers.hub_edit** |
| **Send failed / Podium unavailable** | Readiness + workflow toggle + saved provider location, then **Check Health** | Manager / IT |
| **Automated SMS never fires** | Customer **opt-in** + valid phone + workflow enabled + Podium location saved | Admin + engineering plan |
| **Staff name shows as a UUID** | Manager must link staff to Podium user in **Staff → Edit** | Manager |
| **Review invite sent to opted-out customer** | Check profile **Opt out of review requests**; verify saved before sale completion | Manager / IT |
| **Inbound customer texts never appear** | Confirm the public webhook URL is registered and tunnel/public host is running | IT checks webhook secret/signature and event types |
| **Podium Inbox shows old conversations but not current Podium rows** | Click **Sync Podium** / **Refresh** once and confirm the Settings card still says credentials configured | IT checks OAuth scopes, saved provider location, provider cursor sync, and whether Podium returned the expected conversation page |
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

- [settings-back-office.md](settings-back-office.md) — Settings tabs overview.
- [customers-back-office.md](customers-back-office.md) — Customers workspace.
- [pos-register-cart.md](pos-register-cart.md) — Register and receipt flow.
- [operations-home.md](operations-home.md) — Operations home and Reviews.

**Last reviewed:** 2026-08-09
