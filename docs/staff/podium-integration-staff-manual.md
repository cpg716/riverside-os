# Podium integration (staff manual)

**Audience:** **All staff** who message customers, complete sales, or watch notifications; **admins** who turn Podium on and edit templates.

**Where in ROS:** **Settings → Integrations → Podium** (connection, location, webhooks, and Podium SMS); **Settings → Customer Reviews**; **Settings → Email**; **Settings → Receipt Settings**; **Settings → Online Store** (web chat); **Operations → Podium Inbox**; **POS → Podium Inbox**; Relationship Hub **Messages**; **Operations → Reviews**; **Notification Center** (new SMS).

**Related permissions:** If a screen is missing, ask a manager to check **Staff → Team** (role or overrides). Detail: [STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md), [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md).

**Engineering reference:** [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md).

---

## What this is for

**Podium** is the store’s link between Riverside OS and **customer texting, call awareness, review invites, and optional web chat**. Podium delivers review-request email; other Store Email is handled by the ROS first-party IONOS mailbox. When IT has configured Podium and an admin has enabled it in Settings, Riverside can:

- Send **automatic** texts (e.g. pickup ready, alteration ready) using your wording.
- Let staff **reply** to customers from the **customer profile** without opening Podium’s full Inbox.
- Send a **manual text** from **Podium Inbox** to an existing customer or a new phone number.
- Send **text receipts** from the POS using the standard receipt content.
- Keep each setting with its owner: Podium SMS under **Podium**, operational email under **Email**, review policy and wording under **Customer Reviews**, receipt delivery under **Receipt Settings**, and web chat under **Online Store**.
- Show **new customer texts** as named notifications that open the matching conversation in **Podium Inbox**.
- Show Podium call activity inside the matching conversation, including missed calls and voicemail indicators.
- Show published Podium reviews and business responses in **Operations → Reviews**, and in a customer's Inbox conversation when the review is attributable to Riverside's invitation.
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
| **Operations → Podium Inbox** | Searchable open/closed conversation list, chronological message/call/review thread, **Assigned to**, remembered **Replying as**, rich reply tools, and optional New message form | Review communication activity, assign a conversation without replying, reply even before an unknown sender is linked, add an image or emoji, change the responder with that person's Access PIN, manage read/closed state, open the customer record, and **Refresh** if the list looks stale. |
| **Operations → Reviews** | Published reviews and Riverside response status above the review-request outbox/history | Prioritize **Needs response**, open the provider review, inspect its linked customer/Transaction Record, and manage review invitations. |
| **POS → Podium Inbox** | Same shared inbox inside the POS shell, with the authoritative unread-conversation badge | Read/reply without leaving POS; open the customer record when the conversation needs profile or order follow-up. |
| **POS → Mailbox** | Shared first-party IONOS store email and unread-message badge | Read, reply, forward, triage, or open the matched customer without leaving POS. |
| **Customer hub → Messages** | One text/email thread with compose tools and contact sync | Read history without a duplicate activity list; send text or email; use quick drafts, emoji, and supported attachments; open the provider conversation when available; sync the customer to Podium Contacts. |
| **POS → Receipt summary** | Text receipt and automatic review status | Send a text receipt if the customer wants it; confirm eligible review follow-up is scheduled for five days after fulfillment. |
| **Notification Center** | Podium message alerts and new-store-email alerts, with short popups for newly received activity | Expand a Podium bundle when needed, then open the item to jump to **Podium Inbox**; store-email alerts open **Mailbox**. |

---

## Common tasks

### Admin: confirm Podium is ready (no messages sending)

1. Sign in with a role that can open **Settings** → **Integrations**.
2. Open **Podium**.
3. Check the readiness values: saved credentials, pinned API version, signing-secret state, inbound processing, and the individual text-message toggles required by your SOP.
4. If the card says **credentials missing**, an admin can save or update the Podium credentials in this Settings screen. Use **Authorize via Podium Portal** / **Connect Podium** only after both **Client ID** and **Client Secret** are saved and the redirect URI is registered in Podium.
5. Ensure the Podium app has all required scopes enabled: `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `read_contacts`, and `write_contacts`. Existing connections must use **Reconnect Podium Account** once after `read_contacts` is enabled.
6. Select the correct active location from the provider-backed **Podium location** list and save it. Do not type or copy a raw location UID.
7. Save a webhook signing secret, then use **Register Webhook**. Riverside creates or updates only the subscription matching its public HTTPS URL and selected location, for the message, call, contact, review-invite, published-review, and review-response events it processes. After this integration update, use **Update Webhook** once so the existing Podium subscription includes the added call and full review lifecycle events.
8. In the Podium developer portal, use **Send Test** for the Riverside webhook. A successful response confirms public reachability and signing-secret verification; it does not replace testing a real inbound customer reply.
9. Use **Check Health**, then **Reconcile Contacts** under **Diagnostics and contact maintenance**. Reconciliation starts in the background, so you can leave Settings while it runs. The panel refreshes its progress automatically and shows eligible Riverside customers, confirmed Podium mappings, first-time syncs, queued work, failures, and identity conflicts. The comparison reads the complete Podium contact list in provider-sized pages, keeps successful mappings without resending them, and queues only missing or failed Riverside contacts. Riverside allows one reconciliation at a time and reports an already-running comparison as informational instead of a provider failure. If Riverside restarts during reconciliation, the interrupted audit row is closed and the new server can safely begin the next run. Riverside stops safely if Podium returns an incomplete or unrecognized contact page.

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
2. Under **Linked Podium Staff Member**, select the same person they use to sign in to Podium. The list loads from Podium's user directory; staff never type a provider ID.
3. Save. One Podium identity can link to only one active Riverside staff profile. Messages sent inside Podium and conversation assignments can now show the linked Riverside staff name.
4. Riverside's **Replying as** selection records the PIN-verified Riverside responder directly. The link is needed when a reply or assignment originates in Podium.

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
2. Search or use the **Open**, **Needs reply**, **Unread**, or **Closed** filter, then select a customer thread. The chronological thread opens on the right with messages, Podium call cards, and review cards when a published review is attributable to that customer's Riverside review invitation.
3. Use **Assigned to** in the conversation header to choose an active Riverside staff member with a connected Podium user, or choose **Unassigned**. This saves the Podium assignment immediately without sending a message.
4. Staff without a **Linked Podium Staff Member** do not appear in the assignment list. If an existing Podium assignee says **Not linked**, a manager must connect that identity under **Staff → Team → Edit** before staff can select it.
5. Check **Replying as** above the composer. Riverside remembers that person for this conversation; normal replies do not ask for another PIN.
6. To change the responder, choose another active staff member. The selected person enters their own four-digit **Access PIN** once. After verification, Riverside and Podium credit later replies to that name until it is changed again.
7. Reply from the composer at the bottom of the open thread. Email replies require a subject; SMS replies do not. **Check-in** and **Pickup update** insert editable starter wording, common emoji can be added with one tap, and SMS can include one PNG image up to 5 MB.
8. An unmatched phone number is shown as the conversation's main label and can be answered immediately from the same composer. **Unknown sender** is reserved for the rare event where Podium supplies no usable identifier. Riverside sends to the phone or email stored on that exact provider conversation and records the reply there; matching or adding a customer is optional and can happen later.
9. Use **Open Customer** when the conversation needs profile, Transaction, Fulfillment Order, or wedding follow-up.
10. Choose **New message** when you need to start a separate staff-initiated text. Search/select a current customer or enter a phone number; the form stays closed during normal inbox work.
11. If the phone number is not already a customer, enter the customer’s **first** and **last** name before starting that new outbound conversation. Riverside creates the new contact and records the outbound message.
12. The thread auto-scrolls to the newest activity. Blue outbound messages show the responder's name and time. When a call is newest, the conversation list identifies the row as **Call**; call cards show the call type, time, phone/name, and duration when Podium supplies those fields.
13. Opening an unread conversation marks it read. Use **Mark unread** when another staff member still needs to review it, or **Mark read** after handling it.
14. Select the checkboxes beside multiple conversations to mark them **Read**, **Unread**, **Close**, or **Reopen** together. A partial Podium failure is reported instead of treating the whole group as successful.
15. **Close** is Podium's native closed/archive state. Closed conversations leave the Open list but remain available under **Closed** and can be reopened.
16. Podium assignment and **Replying as** are related but separate controls: assignment owns the conversation; responder identity credits messages.
17. Use **Refresh** to reload the Riverside copy. Open **Status** and use **Pull from Podium** when messages are missing; that action asks Podium for current conversations and their cursor-paged history. **History current** appears only after every matched history in the pull is stored. **History incomplete** means one or more histories still need another pull or IT review.
18. Match an unknown sender only when staff can verify the person. Choose **Match Customer**, search for the intended customer, verify identity, and select that record; the decision is audited against the exact provider conversation ID.
19. When the card says multiple customers share the identifier, correct the duplicate phone/email data or deliberately choose the intended record. Riverside never silently chooses the newest customer.

The Podium Inbox badge counts the same open unread conversations shown in the inbox and refreshes immediately after read/unread actions. Newly delivered messages also enter Notification Center and show a short informational popup while Riverside is open. Existing alerts do not replay as popups at sign-in.

Inbound call activity marks its conversation unread. Missed calls, voicemail indicators, and linked reviews that Podium marks as needing a response place the conversation in **Needs reply**. **Status** shows how many call events Riverside has stored and when the latest one arrived. Call and review cards depend on signed Podium webhooks; **Pull from Podium** recovers message history but does not backfill calls or published reviews. If Podium has calls but Riverside shows zero stored calls, a manager must update the provider webhook under **Settings → Connected Services → Podium**. A voicemail indicator does not guarantee Riverside has the audio recording, so use Podium to listen when no recording control is shown.

**Permission:** Viewing the linked assignment list and changing read/unread state require **`customers.hub_view`**. Assigning/unassigning, sending, creating a new contact, closing, or reopening requires **`customers.hub_edit`**.

### Staff: use the SMS inbox list from POS

1. **POS** → **Podium Inbox**.
2. Select a customer thread. Use **Assigned to** to hand off ownership without sending a reply, then confirm the remembered **Replying as** name before replying. Changing the responder asks only for the selected person's Access PIN.
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
4. **Operations → Reviews** lists Outbox, sent, failed, and cancelled/suppressed outcomes. Closing or auto-closing the receipt cannot lose the scheduled request.

### Manager: check review invite history

1. **Operations** → **Reviews** (subsection). **Published Reviews** shows rating, comment, provider, matched customer/Transaction Record, response status, and the latest Riverside response received from Podium.
2. Prioritize **Needs response**. Use **Open review** to work in the provider surface. When Podium reports the response, Riverside updates both Operations and the linked Inbox review card.
3. Reviews are linked through Podium's review-invitation attribution. If a review says **No Riverside match**, verify it in Podium; Riverside deliberately does not guess the customer.
4. Use **Send Test** only when a manager needs to verify the current review-request wording and real SMS delivery. Enter the authorized test mobile number and confirm. Riverside uses the saved Customer Reviews template and records the acting staff member; it does not create a customer or Transaction.
5. Open **Outbox** to review requests waiting to send. Staff with **`reviews.manage`** may choose **Cancel Invite** and enter a specific reason of at least 12 characters; Riverside records the staff member and reason on the Transaction Record.
6. A request already marked **Sending**, **Sent**, or **Delivered** cannot be cancelled. For **Failed** rows, correct the displayed contact/integration problem before using **Retry**, or open the Transaction Record in Back Office.

**Permission:** **`reviews.view`** to inspect; **`reviews.manage`** to send a delivery test or cancel a scheduled request.

---

## Helping a coworker or customer

- **“Customer says they never got the text.”** Check **profile**: phone number, **operational** / **marketing** SMS flags per store policy; confirm the fulfillment work actually hit **pickup ready** (or the right trigger). Escalate if templates or Podium toggles are wrong—do not spam resends without manager approval.
- **“This phone number is not in ROS yet.”** Reply directly in the conversation labeled with that phone number. Match or add the customer only after identity is clear. Use **New message** with first and last name only when Riverside is starting a separate outbound conversation to a new number.
- **“Notification won’t open the right conversation.”** Open the named item inside the Podium notification bundle. It should route to **Podium Inbox** and select that conversation; IT should verify the stored conversation/customer IDs if it does not.
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
| **Podium assignment says Not linked** | Manager opens **Staff → Team**, edits the matching staff profile, and selects **Linked Podium Staff Member** | Check the `read_users` scope and reconnect Podium if the directory does not load |
| **Opening a conversation leaves it unread** | Use **Mark read** once and refresh | IT checks the Riverside read-state request; failures are no longer silent |
| **Close/Reopen fails for part of a group** | Retry only the named failed conversations | Manager / IT checks `write_messages` and Podium connectivity |
| **Podium shows calls but Riverside does not** | Open Inbox **Status** and check **Stored calls**, then open **Settings → Connected Services → Podium** and update a webhook marked **Needs update** | IT verifies signed call-event delivery; **Pull from Podium** cannot backfill calls |
| **Review invite sent to opted-out customer** | Check profile **Opt out of review requests**; verify saved before sale completion | Manager / IT |
| **Podium Send Test returns 400** | Confirm the Main Hub is on a release that accepts Podium's signed provider-test payload, then retry once | IT checks the recorded webhook failure reason; do not weaken signature verification |
| **Settings says webhook needs update while Inbox says ROS webhook ready** | Treat Settings as the provider-subscription status and use **Update Webhook** there after admin confirmation | **ROS webhook ready** only confirms Riverside has its local signing secret and inbound processing enabled; it does not prove Podium's subscription is enabled or complete |
| **Inbound customer texts never appear** | Confirm Settings says the provider webhook is active, the public webhook URL is registered, and the tunnel/public host is running | IT checks webhook secret/signature, required event types, and the latest accepted delivery |
| **Customer calls never appear** | In Settings → Podium, use **Update Webhook** once and confirm the public webhook remains active | IT verifies Podium is delivering signed call events and checks the retained webhook failure detail; message-history pulls do not backfill calls |
| **Published reviews never appear** | In Settings → Podium, use **Update Webhook** once and confirm `read_reviews` remains authorized | IT verifies Podium is delivering signed review lifecycle events; the review-invite sync does not backfill the published-review feed |
| **Podium Inbox shows old conversations or History incomplete** | Click **Pull from Podium** once; use **Refresh** only to reload the Riverside copy | IT checks the displayed incomplete-pull warning, OAuth scopes, saved provider location, provider cursor sync, and the message-history response |
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

**Last reviewed:** 2026-08-12
