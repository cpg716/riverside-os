# Podium Integration Manual (Riverside OS)

**Audience:** Store admins, cashiers, and anyone using **Customers**, **POS receipts**, or **Operations** workflows that touch Podium.

**Quick SOP (step-by-step for staff):** [podium-integration-staff-manual.md](podium-integration-staff-manual.md).

**What this covers:** Full reference for everything Riverside does with **Podium** (operational SMS/email, web-chat embed, customer threads, receipts, and review-invite tracking). It does **not** replace Podium’s own product documentation or legal terms.

**Technical deep dives (engineers):** [PLAN_PODIUM_SMS_INTEGRATION.md](../PLAN_PODIUM_SMS_INTEGRATION.md), [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md), [PLAN_PODIUM_REVIEWS.md](../PLAN_PODIUM_REVIEWS.md), [RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md). **Permissions detail:** [STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md), [CUSTOMER_HUB_AND_RBAC.md](../CUSTOMER_HUB_AND_RBAC.md).

---

## 1. What Podium does inside Riverside OS

When Podium is **configured on the server** and **enabled in Settings**, Riverside can:

| Capability | Plain-language summary |
|------------|-------------------------|
| **Operational SMS** | Text customers for **ready for pickup**, **alteration ready**, and similar triggers using templates you edit in Settings. |
| **Operational email** | Send **HTML email** for the same kinds of events, plus **appointment confirmation** (when that flow runs), and **loyalty redeem** notices when staff opt in on redeem. |
| **POS receipts** | After checkout, **email** a merged receipt (HTML) or **text** a short message or **picture MMS** (PNG) of the receipt when the Receipt Builder layout is available. |
| **Customer CRM threads** | Show **SMS and email** history on the customer profile, **reply** from Riverside, and optionally store a **Podium conversation URL** for reference. |
| **Inbound messages** | If Podium is allowed to call Riverside’s **webhook**, new customer texts/emails can appear as threads and **notifications** (see section 7). |
| **Web chat on your site** | Paste Podium’s widget snippet so the public storefront can load it (optional build flag). |
| **Review invites (tracking)** | Store whether the cashier chose to **send** or **skip** a post-sale review prompt; **live** Podium review API send is still a roadmap item (see section 8). |

Riverside does **not** recreate Podium’s full multi-user Inbox. Use Riverside for **CRM-context** messaging next to orders and profiles; power users may still use Podium directly.

---

## 2. Who can do what (permissions)

| Task | Typical permission |
|------|---------------------|
| **Settings → Integrations → Podium** (toggles, templates, widget, OAuth connect, readiness) | **`settings.admin`** |
| **Settings → General → Review policy** (enable invites, default send/skip) | **`settings.admin`** |
| **Operations → Inbox** (thread list) | **`customers.hub_view`** |
| **Customer Relationship Hub → Messages** (read thread) | **`customers.hub_view`** |
| **Hub → Messages** (send SMS or email reply, save conversation link) | **`customers.hub_edit`** |
| **Operations → Reviews** (invite/suppress tracking table) | **`reviews.view`** |
| **POS → Receipt summary** (email/text receipt, review skip/send) | Order/register authorization as today (see receipt docs) |
| **Notification Center** (tap inbound SMS/email pings) | **`notifications.view`** (and related inbox behavior) |

POS and Back Office may use **merged staff + register** headers on some routes so an open till can still reach customer or order APIs; if something returns **401/403**, sign in or open the register as required.

---

## 3. Admin setup: Settings → Integrations → Podium

**Where:** Back Office → **Settings** → **Integrations** → **Podium (SMS + web chat)**.

### 3.1 Connect API credentials

Podium needs **OAuth app** credentials and a **refresh token** on the **server** (environment variables). In the UI:

1. Confirm **env credentials present** (pill on the card). If missing, an admin must set server env vars (see section 11).
2. Register the **redirect URI** from the screen in Podium’s developer app. It must match **exactly** (including `http` vs `https`). For local dev, a tunnel or `VITE_PODIUM_OAUTH_REDIRECT_URI` on the client may be required if Podium only allows HTTPS.
3. Click **Connect Podium (get refresh token)** (or connect again to refresh). Complete Podium’s login/consent flow; Riverside exchanges the code for tokens server-side.

If anything fails, use the **readiness** strip (credentials, webhook secret, API base, toggles) before calling Podium support.

### 3.2 Turn channels on

- **Send operational SMS via Podium** — master switch for template-driven SMS (pickup, alteration, unknown-sender welcome, etc.).
- **Send operational email via Podium** — master switch for HTML email paths (pickup, alteration, appointment confirmation email, loyalty email, hub compose, receipts).

Both still require **non-empty Podium location UID** and valid credentials.

### 3.3 Podium location UID

Paste the **location UID** from your Podium account (API/locations). Without it, sends are skipped even if credentials exist.

### 3.4 SMS templates

Editable bodies (defaults apply when a field is left empty at save time):

- **Ready for pickup** — when an order is marked ready for pickup / pickup messaging runs.
- **Alteration ready** — alteration workflow notify path.
- **Unknown-sender welcome** — optional auto-reply when Riverside creates a **stub customer** from an inbound SMS (webhook path); helps collect a name.
- **Loyalty reward redeemed** — when staff choose to notify on redeem and email/SMS flags allow.

**Save** the Integrations card after edits.

### 3.5 Email templates (subject + HTML)

Pairs for:

- Ready for pickup  
- Alteration ready  
- Appointment confirmation  
- Loyalty reward redeemed  

Placeholders in templates are filled by the server at send time (see engineering docs for the exact token names).

### 3.6 Web chat widget (storefront)

- **Enable widget embed** and paste the **snippet** from Podium.
- For the snippet to load on a **public** Riverside build, operators must enable the client flag **`VITE_STOREFRONT_EMBEDS`** and follow **CSP / privacy** guidance: [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](../PODIUM_STOREFRONT_CSP_AND_PRIVACY.md), [ONLINE_STORE.md](../ONLINE_STORE.md).

### 3.7 Review policy (Settings → General)

Admins set store-wide defaults:

- Whether **post-sale review invites** are enabled at all.
- Whether the receipt step should **send an invite by default** or expect cashiers to opt in.

Cashiers still control **per sale** on the receipt summary when invites are enabled (see section 8).

---

## 4. Customer profile: messaging and opt-in

### 4.1 SMS opt-in rules (automated operational SMS)

Automated operational texts respect the customer record: Riverside sends SMS when **`transactional_sms_opt_in`** **or** **`marketing_sms_opt_in`** is true (and phone is usable). Editors can set **operational SMS** when adding or editing customers where the UI exposes it.

Staff **manual** replies from the hub still go through Podium when configured; follow your store’s policy and consent practices for manual outreach.

### 4.2 Operations → Inbox

**Where:** Back Office → **Operations** (home) → **Inbox**.

Shows recent **Podium conversations** with snippets. **Open** a row to jump into that customer’s hub and continue in **Messages**.

Requires **`customers.hub_view`**.

### 4.3 Relationship Hub → Messages tab

**Where:** Open a customer → **Relationship Hub** → **Messages**.

- View the **thread** (inbound webhooks + outbound from Riverside where recorded).
- **Reply** via **SMS** (uses on-file phone) or **email** (subject + body; HTML in compose where provided).
- Optionally save a **Podium conversation URL** on the profile for deep-linking to Podium’s UI.

**View** needs **`customers.hub_view`**; **send/save** needs **`customers.hub_edit`**.

### 4.4 Created from Podium

Inbound SMS from an unknown number may **create a minimal customer** with provenance indicating Podium so staff know to merge or complete the profile if a duplicate exists later.

---

## 5. Automated operational sends (no extra click)

When Podium is configured and toggles are on, Riverside may send without a second staff action:

| Trigger | Channel | Notes |
|---------|---------|--------|
| Order pickup / ready messaging | SMS (+ email if wired for that path) | Uses pickup templates. |
| Alteration ready | SMS / email per `messaging.rs` wiring | Uses alteration templates. |
| Appointment confirmation | Email | Triggered from wedding/appointment flows when the server calls the messaging service. |
| Loyalty reward redeemed | SMS and/or email | Cashier checkboxes on redeem; still require customer opt-in for automated SMS where applicable. |

If something should have sent but did not, verify: **env credentials**, **location UID**, **toggle**, **customer phone/email**, **opt-in**, and server logs (admins).

---

## 6. POS: receipts via Podium

After **Complete sale**, the **Receipt summary** step can:

- **Email receipt** — merged Receipt Builder HTML as inline email via Podium (**requires** saved exported HTML in Receipt Builder).
- **Text receipt** — plain SMS **or** MMS with **PNG** of the receipt when the client can rasterize HTML and Podium attachment limits allow.

Details, limits, and error behavior: [RECEIPT_BUILDER_AND_DELIVERY.md](../RECEIPT_BUILDER_AND_DELIVERY.md).

---

## 7. Inbound webhooks, notifications, and IT checklist

**Endpoint (Podium → Riverside):** `POST /api/webhooks/podium` on your public **Riverside API base URL** (HTTPS in production).

**Verification:** When **`RIVERSIDE_PODIUM_WEBHOOK_SECRET`** is set, Riverside verifies Podium’s **timestamp** and **signature** headers. **Never** enable **`RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED`** outside local development.

**CRM ingest:** Unless **`RIVERSIDE_PODIUM_INBOUND_DISABLED`** is set to a truthy value, verified deliveries are processed so messages can appear under **Customers** and fan out **notifications** (e.g. “New customer SMS”) to staff with **`notifications.view`**.

**Idempotency:** Duplicate Podium retries use a ledger so the same event is not processed twice.

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
| **Connect Podium** fails | Redirect URI mismatch; HTTPS vs HTTP; client override `VITE_PODIUM_OAUTH_REDIRECT_URI`; Podium app client id/secret. |
| **No SMS** | `sms_send_enabled`, location UID, credentials, customer phone, SMS opt-in, template not empty when required. |
| **No email** | `email_send_enabled`, location UID, customer email, template; Receipt Builder exported HTML for email receipts. |
| **502 / Podium unavailable** in UI | Server logs; Podium status; token refresh; API base override. |
| **Inbound never appears** | Webhook URL reachable; secret/signature; `RIVERSIDE_PODIUM_INBOUND_DISABLED` accidentally on; Podium event types. |
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

Set on the **API server** (never commit secrets):

| Variable | Role |
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
