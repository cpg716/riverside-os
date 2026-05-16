# Podium Integration Manual (Riverside OS)

**Audience:** Store admins, cashiers, and anyone using **Customers**, **POS Podium Inbox**, **POS receipts**, or **Operations** workflows that touch Podium.

**Quick SOP (step-by-step for staff):** [podium-integration-staff-manual.md](podium-integration-staff-manual.md).

**What this covers:** Full reference for everything Riverside does with **Podium** (operational SMS, web-chat embed, customer text threads, text receipts, and review-invite tracking). Store email now uses the ROS first-party IONOS mailbox. This does **not** replace Podium’s own product documentation or legal terms.

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
| **Inbound messages** | If Podium is allowed to call Riverside’s **webhook**, new customer texts can appear as threads and **notifications** (see section 7). |
| **Web chat on your site** | Paste Podium’s widget snippet so the public storefront can load it (optional build flag). |
| **Review invites (tracking)** | Store whether the cashier chose to **send** or **skip** a post-sale review prompt; **live** Podium review API send is still a roadmap item (see section 8). |

Riverside does **not** recreate Podium’s full multi-user Inbox. Use Riverside for **CRM-context** messaging next to orders and profiles; power users may still use Podium directly.

---

## 2. Who can do what (permissions)

| Task | Typical permission |
|------|---------------------|
| **Settings → Integrations → Podium** (toggles, templates, widget, OAuth connect, readiness) | **`settings.admin`** |
| **Settings → General → Review policy** (enable invites, default send/skip) | **`settings.admin`** |
| **Operations → Podium Inbox** (thread list, unmatched queue, direct text composer) | **`customers.hub_view`** to view; **`customers.hub_edit`** to send or create a new contact |
| **POS → Podium Inbox** (same shared inbox inside POS shell) | **`customers.hub_view`** to view; **`customers.hub_edit`** to send or create a new contact |
| **Customer Relationship Hub → Messages** (read thread) | **`customers.hub_view`** |
| **Hub → Messages** (send SMS reply, save conversation link) | **`customers.hub_edit`** |
| **Operations → Reviews** (invite/suppress tracking table) | **`reviews.view`** |
| **POS → Receipt summary** (text receipt, review skip/send) | Order/register authorization as today (see receipt docs) |
| **Notification Center** (tap inbound SMS pings) | **`notifications.view`** (and related inbox behavior) |

POS and Back Office may use **merged staff + register** headers on some routes so an open till can still reach customer or order APIs; if something returns **401/403**, sign in or open the register as required.

---

## 3. Admin setup: Settings → Integrations → Podium

**Where:** Back Office → **Settings** → **Integrations** → **Podium (SMS + web chat)**.

### 3.1 Connect API credentials

Podium needs **OAuth app** credentials and a **refresh token** saved securely on the server. Routine credential setup now happens in **Back Office → Settings → Integrations → Podium**. The only credential-related environment setup admins should not manage in the UI is the root encryption key (`RIVERSIDE_CREDENTIALS_KEY`, with `QBO_TOKEN_ENC_KEY` only as a transitional fallback).

| Field in Riverside | Where it comes from |
|--------------------|---------------------|
| **Client ID** | Podium developer app / OAuth app settings. |
| **Client Secret** | Podium developer app / OAuth app settings. Save it securely when Podium shows it. Do not post it in chat or docs. |
| **Refresh Token** | Usually not typed manually. Riverside saves it after **Authorize via Podium Portal** completes successfully. Only paste one if IT is replacing a known token. |
| **API Host** | Normally leave default: `https://api.podium.com`. Only change it if Podium gives a different API origin. |
| **OAuth Token URL** | Normally leave default: `https://api.podium.com/oauth/token`. Only change it if Podium gives a different token URL. |
| **Webhook Signing Secret** | Created/assigned when the Podium webhook is registered. Save it in Riverside so incoming deliveries can be verified. |

1. Confirm the credentials card shows **Client ID** and **Client Secret** as **Saved**. If missing, an admin can enter or update them in this Settings screen.
2. Register the **redirect URI** from the screen in Podium’s developer app. It must match **exactly** (including `http` vs `https`). Production should use the public Riverside host, for example `https://ros.riversidemens.com/callback` when the store tunnel is active. Local `localhost` redirects are only usable if Podium accepts them; otherwise use Cloudflare Tunnel or another HTTPS tunnel plus `VITE_PODIUM_OAUTH_REDIRECT_URI`.
3. Click **Authorize via Podium Portal** / **Connect Podium (get refresh token)** (or connect again to refresh). Riverside asks the server to build the authorization URL with the saved Client ID, redirect URI, state, and required scopes, then Podium handles login/consent and Riverside exchanges the code for tokens server-side.

Riverside requests these Podium OAuth scopes today: `read_locations`, `read_messages`, `write_messages`, `read_reviews`, and `write_reviews`. If Podium shows an empty consent card or a generic authorization error, confirm the app has those products/scopes enabled in Podium and that the redirect URI belongs to the same Client ID.

If anything fails, use the **readiness** strip (credentials, webhook secret, API base, toggles) before calling Podium support.

### 3.2 Turn SMS on

- **Send operational SMS via Podium** — master switch for template-driven SMS (pickup, alteration, unknown-sender welcome, etc.).

SMS still requires **non-empty Podium location UID** and valid credentials.

### 3.3 Podium location UID

Paste the **location UID** from your Podium account (API/locations). Without it, sends are skipped even if credentials exist.

### 3.4 Text message templates

Editable bodies (defaults apply when a field is left empty at save time):

- **Ready for pickup** — when an order is marked ready for pickup / pickup messaging runs.
- **Alteration ready** — alteration workflow notify path.
- **Unknown-sender welcome** — optional auto-reply when Riverside creates a **stub customer** from an inbound SMS (webhook path); helps collect a name.
- **Loyalty reward redeemed** — when staff choose to notify on redeem and email/SMS flags allow.

Use the tag buttons in the Settings panel to insert supported values such as `{first_name}`, `{order_ref}`, `{alteration_ref}`, `{reward_amount}`, `{points_redeemed}`, and `{new_balance}`.

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

### 4.1 SMS opt-in rules (automated operational SMS)

Automated operational texts respect the customer record: Riverside sends SMS when **`transactional_sms_opt_in`** **or** **`marketing_sms_opt_in`** is true (and phone is usable). Editors can set **operational SMS** when adding or editing customers where the UI exposes it.

Staff **manual** replies from the hub still go through Podium when configured; follow your store’s policy and consent practices for manual outreach.

### 4.2 Operations → Podium Inbox

**Where:** Back Office → **Operations** (home) → **Podium Inbox**.

The top **Send Text** composer supports two staff workflows:

- Search and select a current customer, then send SMS to the phone on their profile.
- Enter any phone number. If it is not already matched to a customer phone, Riverside requires **first name** and **last name**, creates a new customer with **Podium** as the source, sends the SMS, and records the outbound message on the new contact.

The inbox also shows recent **Podium conversations** with snippets, unread/needs-reply state, and synced provider threads that need customer matching. **Open** a row to jump into that customer’s hub and continue in **Messages**.

Viewing requires **`customers.hub_view`**. Sending and new-contact creation require **`customers.hub_edit`**.

**Important:** A customer can appear in **Podium Inbox** before Riverside has the full message body history for that thread. The inbox row is backed by a matched **conversation**. The customer **Messages** tab is backed by stored **message** rows. If webhooks were disabled, rejected, or the Podium OAuth grant is missing **`read_messages`**, the profile may show a Podium sync error until IT fixes the webhook/scope issue and runs sync again.

### 4.3 Relationship Hub → Messages tab

**Where:** Open a customer → **Relationship Hub** → **Messages**.

- View the **thread** (inbound webhooks + outbound from Riverside where recorded).
- **Reply** via **SMS** (uses on-file phone) or **email** (subject + body; HTML in compose where provided).
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
| Appointment confirmation | Store email (IONOS) | Managed outside Podium settings through the ROS mailbox/email path. |
| Loyalty reward redeemed | SMS | Cashier checkboxes on redeem; still require customer opt-in for automated SMS where applicable. |

If something should have sent but did not, verify: **Settings credentials**, **location UID**, **SMS toggle**, **customer phone**, **SMS opt-in**, **template content**, and server logs (admins).

---

## 6. POS: text receipts via Podium

After **Complete sale**, the **Receipt summary** step can:

- **Text receipt** — plain SMS receipt text.

Store email receipts use the ROS mailbox/email path backed by IONOS, not Podium.

Details, limits, and error behavior: [RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md).

---

## 7. Inbound webhooks, notifications, and IT checklist

**Endpoint (Podium → Riverside):** `POST /api/webhooks/podium` on your public **Riverside API base URL** (HTTPS in production).

For the current store tunnel, the URL is:

```text
https://ros.riversidemens.com/api/webhooks/podium
```

Do not give Podium a `localhost` webhook URL. Podium must reach Riverside from the internet, so local desktop/dev setups need Cloudflare Tunnel or an equivalent HTTPS tunnel running to the Riverside API. The same public host should also be registered as the OAuth callback host when Podium requires HTTPS redirects.

**Verification:** When **`RIVERSIDE_PODIUM_WEBHOOK_SECRET`** is set, Riverside verifies Podium’s **timestamp** and **signature** headers. **Never** enable **`RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED`** outside local development.

**CRM ingest:** Unless **`RIVERSIDE_PODIUM_INBOUND_DISABLED`** is set to a truthy value, verified deliveries are processed so messages can appear under **Customers** and fan out **notifications** (e.g. “New customer SMS”) to staff with **`notifications.view`**.

**Idempotency:** Duplicate Podium retries use a ledger so the same event is not processed twice.

**What the webhook is used for:** Riverside uses Podium webhooks to receive message activity, persist `podium_message` rows, update the **Podium Inbox** / customer **Messages** thread, create notifications for new inbound customer texts, and preserve a delivery ledger. Outbound sends from Riverside still use the Podium API; the webhook is the return path that lets Riverside see Podium-side activity.

**Webhook setup:** IT can register the webhook through Podium’s API using the saved OAuth credentials. If a webhook already exists, keep its URL pointed at the public Riverside endpoint above and save the signing secret in the Podium credentials card. If the secret is missing or wrong, Riverside rejects signed deliveries before they enter the inbox.

---

## 8. Post-sale review invites (Operations + POS)

**Receipt (POS):** On the receipt summary, cashiers can **skip** or allow a **review invite** according to store defaults set in **Settings → General**.

**What Riverside records today:** If the sale is eligible and not skipped, the order may be stamped with **`review_invite_sent_at`** and a **placeholder** Podium invite id until the live Podium review API is wired. Admins get a **stub** notification explaining that the real Podium send is pending configuration.

**Operations → Reviews:** Staff with **`reviews.view`** see orders with invite **sent** or **suppressed** timestamps and open the order in Back Office from the list.

Full roadmap: [PLAN_PODIUM_REVIEWS.md](../PLAN_PODIUM_REVIEWS.md).

---

## 9. Troubleshooting (quick table)

| Symptom | Things to check |
|---------|----------------|
| **Connect Podium** fails | Redirect URI mismatch; HTTPS vs HTTP; client override `VITE_PODIUM_OAUTH_REDIRECT_URI`; Podium app Client ID / Client Secret. |
| **Podium says Client ID and redirect URI do not match** | The redirect URI used by Riverside is not registered on the same Podium app as the saved Client ID. Register the exact callback URL shown by Riverside, then restart the authorization from Settings. |
| **Podium consent page says something went wrong** | Missing/disabled Podium app scopes or product access; verify `read_locations`, `read_messages`, `write_messages`, `read_reviews`, and `write_reviews` on the Podium app. |
| **Podium page says "Client ID is required"** | The authorization URL did not include a Client ID. Return to Settings, confirm Client ID is saved, and start authorization again from the Podium card. |
| **No SMS** | `sms_send_enabled`, location UID, credentials, customer phone, SMS opt-in, template not empty when required. |
| **Send Text cannot send to a new number** | Enter phone, first name, last name, and message body; confirm the staff member has `customers.hub_edit`. |
| **Store email fails** | IONOS mailbox settings, customer email, and server logs. See [EMAIL_MAILBOX.md](../EMAIL_MAILBOX.md). |
| **502 / Podium unavailable** in UI | Server logs; Podium status; token refresh; API base override. |
| **Inbound never appears** | Public webhook URL reachable; Cloudflare/tunnel running if local; secret/signature; `RIVERSIDE_PODIUM_INBOUND_DISABLED` accidentally on; Podium event types include message activity. |
| **Customer profile has no messages but Podium Inbox has the customer** | The customer likely has a matched Podium conversation shell but no stored `podium_message` rows. Re-enable/fix Podium webhooks, verify OAuth includes `read_messages`, then run Podium sync. |
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

**Client (optional):** **`VITE_PODIUM_OAUTH_REDIRECT_URI`**, **`VITE_STOREFRONT_EMBEDS`**.

Official Podium docs: [Podium — Get Started](https://docs.podium.com/docs/getting-started) and their API reference.
