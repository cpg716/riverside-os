# Podium Integration Manual (Riverside OS)

**Audience:** Store admins, cashiers, and anyone using **Customers**, **POS Podium Inbox**, **POS receipts**, or **Operations** workflows that touch Podium.

**Quick SOP (step-by-step for staff):** [podium-integration-staff-manual.md](podium-integration-staff-manual.md).

**What this covers:** Full reference for everything Riverside does with **Podium** (operational SMS, web-chat embed, customer text threads, text receipts, and review-invite tracking). Podium delivers review-request email; other Store Email uses the ROS first-party IONOS mailbox. This does **not** replace Podium’s own product documentation or legal terms.

**Technical deep dives (engineers):** [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md), [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md), [PLAN_PODIUM_REVIEWS.md](../PLAN_PODIUM_REVIEWS.md), [RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md). **Permissions detail:** [STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md), [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md).

---

## 1. What Podium does inside Riverside OS

When Podium is **configured on the server** and **enabled in Settings**, Riverside can:

| Capability | Plain-language summary |
|------------|-------------------------|
| **Operational SMS** | Text customers for **ready for pickup**, **alteration ready**, and similar triggers using templates you edit in Settings. |
| **POS receipts** | After checkout, **text** a short receipt message. Store email receipts use the ROS IONOS mailbox path. |
| **Customer CRM threads** | Show **SMS** history on the customer profile, **reply** from Riverside, and optionally store a **Podium conversation URL** for reference. |
| **Direct staff texts** | From **Podium Inbox**, send a text to an existing customer or enter a new phone number; new numbers require first and last name and create a Podium-sourced customer contact. |
| **Staff-to-Podium user matching** | Link each staff member to their Podium user identity so messages show the sender’s real name instead of a raw UUID. |
| **Podium contacts sync** | Riverside customers are queued for durable Podium contact upsert on create and update; staff can see provider ID, retry, failure, and last-success evidence or manually sync from the Customer Hub. |
| **Conversation assignees** | See who is assigned to a Podium conversation in the Inbox thread header. |
| **Inbound messages** | If Podium is allowed to call Riverside’s **webhook**, new customer texts can appear as threads and **notifications** (see section 7). |
| **Web chat on your site** | Paste Podium’s widget snippet so the public storefront can load it (optional build flag). |
| **Review invites** | Create a Podium review link, deliver it by Podium text or Podium email, and track skipped/delivered/failed outcomes in Operations (see section 8). |

Riverside does **not** recreate Podium’s full multi-user Inbox. Use Riverside for **CRM-context** messaging next to orders and profiles; power users may still use Podium directly.

---

## 2. Who can do what (permissions)

| Task | Typical permission |
|------|---------------------|
| **Settings → Integrations → Podium** (toggles, templates, widget, OAuth connect, readiness) | **`settings.admin`** |
| **Settings → General → Review policy** (enable invites, default send/skip) | **`settings.admin`** |
| **Operations → Podium Inbox** (conversation list, message thread, reply composer, Send Text, unmatched queue) | **`customers.hub_view`** to view; **`customers.hub_edit`** to send or create a new contact |
| **POS → Podium Inbox** (same shared conversation workspace inside POS shell) | **`customers.hub_view`** to view; **`customers.hub_edit`** to send or create a new contact |
| **Customer Relationship Hub → Messages** (read thread) | **`customers.hub_view`** |
| **Hub → Messages** (send SMS reply, save conversation link) | **`customers.hub_edit`** |
| **Operations → Reviews** (invite/suppress tracking table) | **`reviews.view`** |
| **POS → Receipt summary** (text receipt, review skip/send) | Order/register authorization as today (see receipt docs) |
| **Notification Center** (tap inbound SMS pings) | **`notifications.view`** (and related inbox behavior) |

POS and Back Office may use **merged staff + register** headers on some routes so an open till can still reach customer or order APIs; if something returns **401/403**, sign in or open the register as required.

---

## 3. Admin setup: Settings → Integrations → Podium

**Where:** Back Office → **Settings** → **Integrations** → **Podium (SMS + web chat)**.

### 3.1 Connect Podium (three steps)

The screen now separates the required connection steps from advanced settings. For receipt texts and other outbound messages, you only need to create a Podium OAuth app, save its two keys, and approve Riverside. Riverside saves the refresh token automatically.

| Field in Riverside | Where it comes from |
|--------------------|---------------------|
| **Client ID** | Podium developer app / OAuth app settings. |
| **Client Secret** | Podium developer app / OAuth app settings. Save it securely when Podium shows it. Do not post it in chat or docs. |
| **Refresh Token** | Usually not typed manually. Riverside saves it after **Authorize via Podium Portal** completes successfully. Only paste one if IT is replacing a known token. |
| **API Host** | Normally leave default: `https://api.podium.com`. Only change it if Podium gives a different API origin. |
| **OAuth Token URL** | Normally leave default: `https://api.podium.com/oauth/token`. Only change it if Podium gives a different token URL. |
| **Webhook Signing Secret** | Created/assigned when the Podium webhook is registered. Save it in Riverside so incoming deliveries can be verified. |

1. Click **Open Podium Developer Portal**, create the OAuth app, and register **`https://ros.riversidemens.com/callback`**. Riverside displays this public callback even when Settings was opened from the Main Hub's internal address. If Riverside shows **Open Secure Riverside**, use that action and sign in at the secure address before continuing; OAuth must start and finish on the same browser origin.
2. Copy only the **Client ID** and **Client Secret** into Riverside and save them.
3. Click **Connect Podium Account**, sign in to Podium, and approve Riverside. The button stays disabled until both keys are saved and Riverside is open from an HTTPS address. After approval, Riverside exchanges the code and saves the refresh token securely.

The refresh token, API host, and OAuth token URL are under **Advanced and incoming-message setup** because they are not normally entered by staff. The webhook signing secret is only needed when configuring verified incoming Podium messages.

Riverside requests these Podium OAuth scopes today: `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `read_contacts`, and `write_contacts`. Existing connections must be reconnected once after enabling `read_contacts`. If Podium shows an empty consent card or a generic authorization error, confirm the app has those products/scopes enabled in Podium and that the redirect URI belongs to the same Client ID.

If anything fails, use the **readiness** strip (credentials, webhook secret, API base, toggles), then click **Check Podium Health**. The live check refreshes the saved OAuth token and verifies authenticated access for locations, messages, contacts, reviews, and users; a green result is stronger than basic network reachability but still does not send a message.

Use **Reconcile Contacts** after reconnecting. This bulk action requires **`settings.admin`**, a saved Podium location UID, and an active OAuth grant with `read_contacts`. Riverside permits only one reconciliation at a time, reads every cursor-paged Podium contact, compares normalized phone/email identifiers without choosing between duplicates, applies safe Podium edits and SMS opt-outs to ROS, creates a Podium-sourced ROS customer when no match exists, and queues eligible ROS customers for outbound parity. If a page or contact identity cannot be parsed completely, the run fails before treating any mapped contact as absent. Contact deletes preserve the ROS customer for ledger/history safety and suppress silent recreation; merges, deletes, conflicts, and successful changes are audit events.

Riverside remains the appointment calendar and booking source of truth. Podium delivers enabled appointment confirmations, reminders, and the calendar attachment; staff should not maintain a second appointment schedule in Podium.

### 3.2 Choose which texts are enabled

Podium text delivery is controlled separately for **staff-authored texts**, **text receipts**, **ready for pickup**, **alteration ready**, **appointment confirmation**, **appointment reminder**, and the **new-sender welcome**. Turning on one does not turn on the others. Review requests continue to use their separate store review policy.

SMS still requires **non-empty Podium location UID** and valid credentials.

### 3.3 Podium location UID

Paste the **location UID** from your Podium account (API/locations). Without it, sends are skipped even if credentials exist.

### 3.4 Customer message templates

The Podium settings card is the shared editor for customer-facing delivery messages. Defaults apply when a saved field is empty, and **Reset** restores the shipped wording.

**Operational SMS:**

- **Ready for pickup** — when an order is marked ready for pickup / pickup messaging runs.
- **Alteration ready** — alteration workflow notify path.
- **Appointment confirmation** — customer appointment creation; SMS/MMS attempts to attach `riverside-appointment.ics`.
- **Appointment reminder** — customer appointment reminder about 24 hours before the appointment time.
- **Unknown-sender welcome** — optional auto-reply when Riverside creates a **stub customer** from an inbound SMS (webhook path); helps collect a name.

**Operational Store Email:** Ready-for-pickup, alteration-ready, appointment-confirmation, and appointment-reminder subjects and HTML bodies are editable separately. These messages are sent through Store Email, not Podium.

**Review requests:** Edit the Podium SMS body plus Podium email subject and body. Both bodies must retain `{review_url}` so the customer receives the official Podium review link.

**Receipt delivery:** Edit the normal and gift-receipt Podium MMS captions and Store Email subjects. The actual receipt image, financial content, and plain-text fallback remain controlled by **Receipt Settings** so a message edit cannot remove required receipt details.

Use the tag buttons to insert supported customer, store, and event values. Available values include `{first_name}`, `{last_name}`, `{full_name}`, `{customer_code}`, `{transaction_ref}`, `{alteration_ref}`, `{appointment_type}`, `{appointment_date}`, `{appointment_time}`, `{starts_at}`, `{store_name}`, `{store_phone}`, `{store_email}`, `{store_address}`, `{review_url}`, `{receipt_ref}`, and `{receipt_type}`. The editor shows only the values supported by each message.

**Save** the Integrations card after edits.

### 3.5 Web chat widget (storefront)

- **Enable widget embed** and paste the **snippet** from Podium.
- For the snippet to load on a **public** Riverside build, operators must enable the client flag **`VITE_STOREFRONT_EMBEDS`** and follow **CSP / privacy** guidance: [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md), [ONLINE_STORE.md](../ONLINE_STORE.md).

### 3.6 Review policy (Settings → General)

Admins set store-wide defaults:

- Whether **post-sale review invites** are enabled at all.
- Whether the receipt step should **send an invite by default** or expect cashiers to opt in.

Cashiers still control **per sale** on the receipt summary when invites are enabled (see section 8).

---

## 4. Customer profile: messaging and opt-in

### 4.1 Communication preferences (SMS, email, review requests)

Automated operational texts respect the customer record: Riverside sends SMS when **`transactional_sms_opt_in`** **or** **`marketing_sms_opt_in`** is true (and phone is usable). Editors can set **operational SMS** when adding or editing customers where the UI exposes it.

**Review requests opt-out:** Customers can opt out of Podium review requests on their profile (Customer Hub → Communication preferences → **Opt out of review requests**). When enabled, Riverside will never send a review invite for that customer. This review-only preference does not change the customer's SMS/email permissions or Podium campaign unsubscribe state.

Staff **manual** replies from the hub still go through Podium when configured; follow your store's policy and consent practices for manual outreach.

### 4.2 Operations → Podium Inbox

**Where:** Back Office → **Operations** (home) → **Podium Inbox**.

The inbox is a conversation workspace:

- The left side shows recent Podium conversations with customer name, channel, latest message, timestamp, and needs-reply state.
- Selecting a conversation opens the message thread on the right so staff can read the exchange in context and reply without leaving the inbox.
- **Open Customer** jumps to the customer hub when staff need profile, order, or wedding context.
- **Send Text** supports new outbound messages from the same workspace.

**Send Text** supports two staff workflows:

- Search and select a current customer, then send SMS to the phone on their profile.
- Enter any phone number. If it is not already matched to a customer phone, Riverside requires **first name** and **last name**, creates a new customer with **Podium** as the source, sends the SMS, and records the outbound message on the new contact.

Unmatched provider threads are grouped under **Unknown Podium senders** so the main inbox stays focused on usable conversations. Choose **Match customer**, search/select the verified customer, and let Riverside import the exact provider conversation. When duplicate phone/email values produce multiple candidates, Riverside quarantines the thread instead of silently selecting the newest customer.

Viewing requires **`customers.hub_view`**. Sending and new-contact creation require **`customers.hub_edit`**.

**Inbox freshness:** Riverside receives new Podium messages by webhook when the public webhook is configured. The Inbox screen refreshes every minute while open, and Riverside runs a background Podium pull every 30 minutes by default to catch missed history. Use **Pull from Podium** when staff want an immediate missed-history check.

**Thread UI:** The message thread auto-scrolls to the newest message and displays a **Sent** badge on outbound messages. The conversation header shows assigned Podium users when available. Assigning or clearing a user updates Podium's assignee list; if Podium rejects the change, Riverside shows the provider error instead of pretending it was saved.

**Important:** A customer can appear in **Podium Inbox** before Riverside has the full message body history for that thread. The inbox row is backed by a matched **conversation**. The customer **Messages** tab is backed by stored **message** rows. If webhooks were disabled, rejected, or the Podium OAuth grant is missing **`read_messages`**, the profile may show a Podium sync error until IT fixes the webhook/scope issue and runs sync again.

### 4.3 Relationship Hub → Messages tab

**Where:** Open a customer → **Relationship Hub** → **Messages**.

- Use **Podium** to view and reply to SMS threads (inbound webhooks + outbound from Riverside where recorded). The reply box sits below the thread. Staff can add emoji and a PNG image attachment when sending SMS/MMS.
- Use **Email** to view customer email activity and send email replies. Email compose supports file attachments and automatically uses the logged-in staff member's saved email signature when available.
- Podium and Email tabs show an alert dot when the latest customer message in that channel still needs a reply.
- Optionally save a **Podium conversation URL** on the profile for deep-linking to Podium’s UI.

**View** needs **`customers.hub_view`**; **send/save** needs **`customers.hub_edit`**.

### 4.4 Created from Podium

Inbound SMS from an unknown number may **create a minimal customer** with provenance indicating Podium so staff know to merge or complete the profile if a duplicate exists later.

Staff-initiated **Send Text** from Podium Inbox follows a stricter rule: a phone-only send is allowed only when the number already matches a customer. If it does not match, staff must enter first and last name before Riverside creates the contact and sends the message.

---

## 5. Automated operational sends (no extra click)

When Podium is configured and toggles are on, Riverside may send without a second staff action:

| Trigger | Channel | Notes |
|---------|---------|--------|
| Order pickup / ready messaging | SMS | Uses the pickup text template. |
| Alteration ready | SMS | Uses the alteration text template. |
| Appointment confirmation | SMS/MMS + Store email (IONOS) | SMS/MMS uses the Podium appointment confirmation template and attempts to attach `riverside-appointment.ics`. Email also includes `riverside-appointment.ics`. |
| Appointment reminder | SMS + Store email (IONOS) | Sends about 24 hours before the appointment time. |

Every row above uses the current saved message template at send time. Operational email subjects/bodies and SMS bodies can be edited under **Settings → Integrations → Podium → Customer Messages & Web Chat**.

If something should have sent but did not, verify: **Settings credentials**, **location UID**, **SMS toggle**, **customer phone**, **SMS opt-in**, **template content**, and server logs (admins).

Loyalty reward redemptions do not send automated SMS/email. Customer notice for loyalty rewards remains the physical loyalty letter workflow.

---

## 6. POS: text receipts via Podium

After **Complete sale**, the **Receipt summary** step can:

- **Text receipt** — plain SMS receipt text.

Store email receipts use the ROS mailbox/email path backed by IONOS, not Podium. Admins can edit receipt email subjects and Podium MMS captions in the Podium message catalog; Receipt Settings remains authoritative for the receipt itself.

Details, limits, and error behavior: [RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md).

---

## 7. Inbound webhooks, notifications, and IT checklist

**Endpoint (Podium → Riverside):** `POST /api/webhooks/podium` on your public **Riverside API base URL** (HTTPS in production).

For the current store tunnel, the URL is:

```text
https://ros.riversidemens.com/api/webhooks/podium
```

Do not give Podium a `localhost` webhook URL. Podium must reach Riverside from the internet, so local desktop/dev setups need Cloudflare Tunnel or an equivalent HTTPS tunnel running to the Riverside API. The same public host should also be registered as the OAuth callback host when Podium requires HTTPS redirects.

Admins can check the current public callback origin, Podium webhook URL, signing-secret readiness, and local Cloudflare Tunnel helper in **Settings → Remote Access → Edge & Webhook Access**. Use **Run Live Callback Check** to verify the configured public HTTPS route reaches this Riverside OS server before relying on inbound messages. After sending a Podium dashboard test event, refresh the panel and confirm **Podium provider delivery** shows a recent delivery timestamp. This is a visibility check only; Riverside does not manage Cloudflare DNS or WAF rules.

**Verification:** When **`RIVERSIDE_PODIUM_WEBHOOK_SECRET`** is set, Riverside verifies Podium’s **timestamp** and **signature** headers. **Never** enable **`RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED`** outside local development.

**CRM ingest:** Unless **`RIVERSIDE_PODIUM_INBOUND_DISABLED`** is set to a truthy value, verified deliveries are processed so messages can appear under **Customers** and fan out **notifications** (e.g. “New customer SMS”) to staff with **`notifications.view`**. Riverside stores a verified event before acknowledging Podium, then processes it from a retryable queue. A temporary database failure therefore appears as pending/retrying work instead of silently losing the event.

**Idempotency:** Duplicate Podium retries use a ledger so the same event is not processed twice.

**What the webhook is used for:** Riverside uses Podium webhooks to receive message activity, persist `podium_message` rows, update the **Podium Inbox** / customer **Messages** thread, create notifications for new inbound customer texts, apply contact lifecycle events, and preserve a delivery ledger. Enable `message.received`, relevant message sent/failed events, `contact.created`, `contact.updated`, `contact.deleted`, `contact.merged`, and `contact.unchanged`. Outbound sends from Riverside still use the Podium API; the webhook is the return path that lets Riverside see Podium-side activity.

**Webhook setup:** IT can register the webhook through Podium’s API using the saved OAuth credentials. If a webhook already exists, keep its URL pointed at the public Riverside endpoint above and save the signing secret in the Podium credentials card. If the secret is missing or wrong, Riverside rejects signed deliveries before they enter the inbox.

---

## 8. Post-sale review invites (Operations + POS)

**Receipt (POS):** The receipt summary shows when an eligible fulfilled Transaction has entered the review schedule. Staff do not select individual customers for review requests. Managers can turn the store-wide workflow off in **Settings → General**, and each customer can opt out in Customer Hub.

**When Riverside sends:** Riverside waits until **10:00 AM five days after fulfillment or pickup** (Monday when that day is Sunday). It then creates the official review link through Podium. If the customer has a usable phone, Riverside texts that link through Podium. If email is the only usable destination, Riverside sends the link through Podium email. The Transaction Record is marked sent only after Podium accepts the message. Podium message failures are correlated back to the exact Transaction when Podium supplies its message UID. Riverside only asks each customer once every **180 days**.

**Operations → Reviews:** Staff with **`reviews.view`** see **scheduled**, **sending**, **sent**, **failed**, and **suppressed** Transaction Records, including the scheduled/attempt time and provider error. Use **Retry** on a failed row to return it to the controlled delivery schedule after correcting its phone/email or integration problem. Riverside refreshes Podium review state in the background; **Podium** remains available for an immediate manual refresh.

Full roadmap: [PLAN_PODIUM_REVIEWS.md](../PLAN_PODIUM_REVIEWS.md).

---

## 9. Troubleshooting (quick table)

| Symptom | Things to check |
|---------|----------------|
| **Connect Podium** fails | Redirect URI mismatch; HTTPS vs HTTP; client override `VITE_PODIUM_OAUTH_REDIRECT_URI`; Podium app Client ID / Client Secret. |
| **Podium says Client ID and redirect URI do not match** | The redirect URI used by Riverside is not registered on the same Podium app as the saved Client ID. Register the exact callback URL shown by Riverside, then restart the authorization from Settings. |
| **Podium consent page says something went wrong** | Missing/disabled Podium app scopes or product access; verify `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `read_contacts`, and `write_contacts` on the Podium app. |
| **Podium page says "Client ID is required"** | The authorization URL did not include a Client ID. Return to Settings, confirm Client ID is saved, and start authorization again from the Podium card. |
| **No SMS** | The specific message-type toggle, location UID, credentials, customer phone, SMS opt-in, and a non-empty template when required. |
| **Send Text cannot send to a new number** | Enter phone, first name, last name, and message body; confirm the staff member has `customers.hub_edit`. |
| **Store email fails** | IONOS mailbox settings, customer email, and server logs. See [EMAIL_MAILBOX.md](../EMAIL_MAILBOX.md). |
| **502 / Podium unavailable** in UI | Server logs; Podium status; token refresh; API base override. |
| **Inbound never appears** | Public webhook URL reachable; Cloudflare/tunnel running if local; secret/signature; `RIVERSIDE_PODIUM_INBOUND_DISABLED` accidentally on; Podium event types include message activity. |
| **Podium webhook says Disabled** | Do not simply enable it. Deploy the build containing the current webhook envelope and queue migration, use Podium **Send Test**, confirm `200` and completed processing in Riverside, then enable and save the webhook. |
| **Scheduled notice says failed** | Open the delivery detail. Riverside now reports the channels that actually succeeded (`sms`, `email`, `both`, or `none`) and keeps the provider/setup error instead of marking every attempt delivered. |
| **Customer profile has no messages but Podium Inbox has the customer** | The customer likely has a matched Podium conversation shell but no stored `podium_message` rows. Re-enable/fix Podium webhooks, verify OAuth includes `read_messages`, then run Podium sync. |
| **Staff name shows as a UUID in messages** | The staff member is not linked to a Podium user. A manager with `staff_edit` can open **Staff → Edit** and select the matching Podium user from the dropdown. |
| **Review invite sent to a customer who opted out** | Check the customer's profile: if **Opt out of review requests** is checked, the invite should have been suppressed. If it still sent, verify the opt-out was saved and the transaction detail refreshed before sale completion. |
| **Widget missing on site** | `VITE_STOREFRONT_EMBEDS`; snippet saved; CSP blocking scripts—see [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md). |

---

## 10. Related staff guides

- **Settings overview:** [settings-back-office.md](settings-back-office.md)  
- **Customers workspace:** [customers-back-office.md](customers-back-office.md)  
- **POS register / receipt UX:** [pos-register-cart.md](pos-register-cart.md)  
- **Gift cards & loyalty:** [gift-cards-loyalty-back-office.md](gift-cards-loyalty-back-office.md)  
- **Operations home** (includes Reviews): [operations-home.md](operations-home.md)

---

## 11. Environment variables (reference for admins / IT)

Manage routine Podium credentials in **Settings → Integrations → Podium** (never commit secrets):

| Credential / setting | Role |
|----------|------|
| **`RIVERSIDE_PODIUM_CLIENT_ID`** / **`CLIENT_SECRET`** | OAuth app |
| **`RIVERSIDE_PODIUM_REFRESH_TOKEN`** | Long-lived refresh from Connect flow |
| **`RIVERSIDE_PODIUM_OAUTH_TOKEN_URL`** | Optional non-default token host |
| **`RIVERSIDE_PODIUM_API_BASE`** | Optional REST base (default `https://api.podium.com`) |
| **`RIVERSIDE_PODIUM_WEBHOOK_SECRET`** | Verify inbound webhooks |
| **`RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED`** | Dev only |
| **`RIVERSIDE_PODIUM_INBOUND_DISABLED`** | Skip CRM ingest; verified deliveries may still be recorded in the webhook ledger |
| **`RIVERSIDE_PODIUM_SYNC_INTERVAL_SECS`** | Optional fallback inbox pull interval; default 30 minutes, minimum 10 minutes |
| **`RIVERSIDE_PODIUM_CONTACT_SYNC_INTERVAL_SECS`** | Durable ROS-to-Podium contact outbox interval; default 30 seconds, minimum 10 seconds |

**Client (optional):** **`VITE_PODIUM_OAUTH_REDIRECT_URI`**, **`VITE_STOREFRONT_EMBEDS`**.

Official Podium docs: [Podium — Get Started](https://docs.podium.com/docs/getting-started) and their API reference.
