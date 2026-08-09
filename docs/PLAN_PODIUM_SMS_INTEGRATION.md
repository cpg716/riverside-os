# Plan: Podium SMS integration (Riverside OS)

**Status:** **Fully implemented** — All planned Podium API endpoints are wired, including staff identity mapping, contacts sync, conversation assignees, and review invite automation. **Consolidated completion matrix:** **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)**. This document is the **deep spec** (env, receipts, widget); §Goals / §Future phases below include **older** text — use the master plan for **shipped vs deferred**.

Implementation plan for **(A)** **transactional / operational SMS** from Riverside OS via the Podium API, **(A2)** **transactional email** via the same Podium integration where the product uses Podium for order-adjacent mail (scoped for **web `sale_channel`** and shared triggers in **[`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)** §8), **(B)** the **Podium web chat / SMS widget** on the **public online storefront**, and **(C)** **two-way CRM messaging** — **shipped** (**99**+): **`podium_conversation` / `podium_message`**, **Operations → Inbox** direct text composer and unmatched queue, relationship-hub **Messages**, staff reply; **Notification Center** fan-out + **`read-all`** + nudge — see **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)**. Remaining **polish**: optional dedicated **SMS Module** thread list in **Settings** mirroring every Notification Center row and **`sms.templates`** RBAC. ROS does **not** rebuild Podium’s full Inbox. See **[`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)** §8 for storefront placement, widget, and **transactional email** boundaries vs **Constant Contact** (marketing).

---

## Shipped (current codebase)

| Area | What exists |
|------|-------------|
| **Schema** | Migration **`70_podium_sms_config.sql`**: `store_settings.podium_sms_config` JSONB. Migration **`71_podium_webhook_transactional_sms.sql`**: **`customers.transactional_sms_opt_in`**, **`podium_webhook_delivery`**. Migration **`99_podium_messaging_reviews.sql`**: **`podium_conversation`**, **`podium_message`**, **`customer_created_source` `podium`**, review RBAC keys (see **`PLAN_PODIUM_REVIEWS.md`**). Migration **`104_podium_message_sender_name.sql`**: **`podium_message.podium_sender_name`**. Active baseline migration **`028_podium_communications_hardening.sql`** adds inbox read/sync metadata, webhook failure logging, unmatched provider-conversation queueing, and review invite provider status/url columns. Migration **`187_podium_contact_reconciliation.sql`** adds durable contact outbox state, audit events, reconciliation runs/issues, collision evidence, and audited manual conversation resolution. |
| **Server** | **`server/src/logic/podium.rs`** — refresh-token OAuth using encrypted integration credentials, cached access token on **`AppState.podium_token_cache`**, E.164 normalization. Wired endpoints include **`GET /v4/locations`**, **`GET/POST/PUT /v4/webhooks`**, **`POST /v4/messages`**, **`POST /v4/messages/attachment`** (multipart, provider 30 MB cap), cursor-paged conversations/messages/users/review invites, contact create/update/read, and assignee GET/PUT with `assigneeUids`. Safe reads retry network/5xx; all authenticated calls refresh once on 401 and honor 429/`Retry-After`; mutations do not blindly retry ambiguous failures. All Podium requests include the pinned **`podium-version`** header. |
| **Messaging** | **`server/src/logic/messaging.rs`** — pickup, alteration, appointment confirmation, and appointment reminder SMS from DB templates; Podium when encrypted credentials, **`location_uid`**, and that workflow's independent **`sms_features`** toggle are configured. Staff-authored texts, receipts, pickup, alteration, appointment confirmation, appointment reminder, and new-sender welcome can each be enabled alone. SMS allowed when customer transactional SMS rules allow it. Appointment confirmation SMS uses **`POST /v4/messages/attachment`** to attempt `riverside-appointment.ics` delivery. Store email uses the ROS mailbox/email path for editable operational HTML and appointment `.ics` attachments. The same settings JSON also stores editable Podium review SMS/email and normal/gift receipt MMS captions/email subjects. Loyalty reward redemption does not send automated SMS/email; customer notice remains the physical loyalty letter workflow. Receipts and hub messages use **`podium.rs`** / mailbox paths from **`transactions.rs`** / **`customers.rs`**. Web-order-only marketing boundaries remain in **[`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)** §8. |
| **Settings API** | **`GET` / `PATCH /api/settings/customer-communications`** uses narrow domain patches while **`/podium-sms`** remains a compatibility alias. **`GET /api/settings/podium/provider-setup`** reads provider locations/subscriptions; **`POST /api/settings/podium/webhook`** creates or updates the exact selected-location/public-URL subscription after explicit admin confirmation. |
| **Webhooks** | **`POST /api/webhooks/podium`** verifies **`podium-timestamp`** + **`podium-signature`** over the exact raw body, durably stores verified JSON, and returns before CRM processing. Riverside registers message received/sent/failed, contact lifecycle, and review invite-link created/updated events. Migration **183** supplies leases, retry/backoff, crash reclamation, and terminal alerts. API pull remains missed-history recovery, not a replacement for an enabled webhook. |
| **Public API** | **`GET /api/public/storefront-embeds`** — unauthenticated JSON for public builds to inject widget snippet when enabled. |
| **Client** | **Settings → Podium** owns OAuth, provider location, webhook subscription, Podium SMS, and maintenance. **Settings → Email**, **Customer Reviews**, **Receipt Settings**, and **Online Store** own their wording/policy/widget controls. Blank wording fields inherit the server default instead of copying defaults into saved JSON. **Operations/POS → Podium Inbox** and **Customer Hub** retain messaging and contact-sync workflows. |
| **POS receipts** | After checkout, **`ReceiptSummaryModal`**: **Email receipt** → **`POST /api/transactions/{id}/receipt/send-email`** through Store Email; **gift** variant + line subset via JSON **`gift`** / **`transaction_line_ids`**. **Text receipt** → **`POST …/receipt/send-sms`** with optional **PNG** (`png_base64`) for **`/v4/messages/attachment`**, else plain SMS — **`docs/RECEIPT_BUILDER_AND_DELIVERY.md`**. |
| **Docs** | **`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`** — CSP / privacy checklist for the storefront widget. **`docs/RECEIPT_BUILDER_AND_DELIVERY.md`** — Receipt settings + Podium delivery. |
| **Secrets / Settings** | Routine Podium credentials are saved through **Settings → Integrations → Podium** and stored in encrypted integration credentials. Deployment env is still valid for root encryption key setup and non-secret runtime flags such as **`RIVERSIDE_PODIUM_WEBHOOK_ALLOW_UNSIGNED`** / **`RIVERSIDE_PODIUM_INBOUND_DISABLED`**. Client optional **`VITE_PODIUM_OAUTH_REDIRECT_URI`** remains a build/runtime setting. |

**Polish / operational boundary:** **`sms.templates`** RBAC split still uses **`settings.admin`**. A code-complete integration is not live proof: deploy the exact build, reconnect OAuth when scopes change, register/update the provider webhook, send real signed provider events, and verify live send/receive/contact/review behavior before operational certification.

**Appointment boundary:** ROS remains the appointment system of record (`wedding_appointments` and `/api/weddings/appointments`). Podium is used to deliver appointment confirmation/reminder messages and the appointment `.ics` attachment; ROS does not create a second Podium-managed appointment calendar or synchronize booking state bidirectionally.

---

**Reference docs:** [Podium — Get Started](https://docs.podium.com/docs/getting-started), [Send a Message (SMS or Email)](https://docs.podium.com/docs) (Guides), [Podium API reference](https://docs.podium.com/reference) / Postman collection linked from Get Started; Podium guides for **webhooks** and **sync messages from Podium conversations** (for inbound / history).

**Related (ROS):** **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)** — Shippo + Podium + notifications + reviews **tracker**. **[`PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md)** — inbox, fan-out, **`read-all`**, **`messaging_unread_nudge`**. **Reviews (stub API):** **[`PLAN_PODIUM_REVIEWS.md`](./PLAN_PODIUM_REVIEWS.md)**.

**Staff manual:** [`docs/staff/podium-integration-staff-manual.md`](staff/podium-integration-staff-manual.md).

---

## Goals

> **§Goals / §Future phases below** use **original phase labels** for traceability. **Shipped vs open** is summarized at the top of this file and in **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)**.

### Phases 0–2 (initial delivery)

- Deliver **real SMS** when `MessagingService` fires today (e.g. **ready for pickup** on order fulfilled, **alteration ready** in `alterations.rs`). **Done** (Podium path when configured).
- **SMS Module** (Back Office): **(1) Automated SMS templates** — **done** under **Settings → Integrations → Podium** (`settings.admin`). **(2)** **Operational SMS / Podium** pings in **Notification Center** + deep links to Customers / hub — **done** (**99**+). **Optional:** a **second** list inside Settings that duplicates the full thread browser — not required for CRM reply flows. Sending code **loads body text** from **`podium_sms_config`** with **code defaults** merged when fields are empty; pickup/alteration use stored templates at send time.
- Respect **`customers.transactional_sms_opt_in` OR `customers.marketing_sms_opt_in`** and valid **`customers.phone`** (E.164-friendly storage per migration notes).
- **No secrets in logs**; use `tracing` with redaction where needed.
- **Graceful degradation**: if Podium is not configured, keep current **tracing-only** behavior or explicit no-op (configurable).

### Future phases (after MVP send path) — *largely satisfied in **99**+*

- **Two-way data in ROS**: store Podium conversation/message identifiers and bodies (or previews) tied to **`customers`**, with **webhooks** and, where needed, Podium **conversation sync** APIs. **Shipped:** **`podium_conversation`**, **`podium_message`**, inbound **`podium_webhook`** → **`podium_inbound`** path; staff reply APIs. **Open:** full historical **sync** from Podium for pre-ROS threads (if ever needed).
- **Inbox in ROS**: **Operations → Inbox** lists Podium threads (**`customers.hub_view`**); hub **Messages** opens from a row or from **Customers**. **Notification Center** + **`read-all`** — shipped. **Optional later:** duplicate thread list under **Settings → Podium**.
- **Message attribution badges** in the thread: **Customer** (inbound), **Automated** (ROS-triggered operational sends — pickup/alteration/etc.), **Staff** (human replies; best-effort match to logged-in ROS staff vs Podium user).
- **Notification state**: distinguish **opened/dismissed** (user saw the ping in ROS) from **responded** (business state, e.g. a **Staff** outbound after the triggering inbound, or a reliable signal from Podium — do not equate “opened” with “replied”).
- **Unknown inbound numbers**: **find-or-create** a **minimal customer** by normalized **E.164** phone, with clear **provenance** (e.g. profile banner **Created from Podium SMS** / DB `created_source`-style field), default **marketing opt-outs**, and a **merge/link** path when a full CRM record already exists or is created later.
- **Welcome + name capture**: For **stub** / unnamed inbound contacts, send an **automated reply**; full copy is edited in the **SMS Module** (see below). When they text back, **parse and apply** `first_name` / `last_name` on the profile when confident; staff can always **correct** names in the profile while chatting.
- **Notification titles**: New SMS notifications may show **phone only** until a name exists; if the customer replies with a name **before** the notification is opened, the list row should **update** to the resolved name (live or on refresh — implementation detail: polling, realtime channel, or refetch on focus).

## Non-goals (initial phase — Phases 0–2)

- **Rebuilding Podium’s full Inbox** (global queue, assignment UX, bulk triage) inside ROS.
- *(Historical — superseded:)* ~~Inbound CRM before Phase 4+~~ — **inbound threads + notifications shipped** (**71** preview, **99**+ CRM). Remaining scope is **polish** and optional **Settings**-embedded lists, not greenfield build.
- Podium **Invoices / card reader** flows ([Collect Your First Payment with a Card Reader](https://docs.podium.com/docs)) — Helcim remains in-register for ROS.

## Non-goals (explicit deferral)

- Replacing Podium’s native Inbox for power users; ROS complements it for **CRM-context** messaging and **operational awareness**.

---

## Target UX: SMS Module, Notification Center, and profile threads *(original Phase 4+ spec — core paths shipped **99**+)*

| Element | Behavior |
|--------|----------|
| **Threads** | One logical thread per customer (keyed by `customer_id` + Podium conversation/contact ids as stored). Primary UI is **Customer profile → SMS section**, not a separate inbox list. |
| **SMS notification list (shared)** | **Past and present** SMS notifications (e.g. new inbound SMS). The **same list** appears **(1)** in the **SMS Module** (alongside template editing) and **(2)** in the shell **Notification Center** panel/drawer. **Click** a row → **customer profile slideout** → **SMS** section. Optional lightweight filters later (**Unread**, **Needs reply**) if volume grows. |
| **Alert / badge** | When there is **unread** SMS notification activity, both the **SMS** shell control (icon / nav entry that opens the SMS Module) and the **Notification Center** icon show an **alert** (dot, count, or both — product choice). Clearing/read rules apply consistently so both entry points stay in sync. |
| **Notification label** | Prefer **display name** when `first_name` / `last_name` are set; otherwise **formatted phone**. Labels should **update** when name capture succeeds **before** open (see **Unknown-sender welcome** below). |
| **Badges** | **Customer** / **Automated** / **Staff** on each message line or grouping. |
| **Staff ↔ Podium** | **Best-effort**: when staff sends **from ROS**, attribute to current staff. When sends occur **only in Podium** (mobile app, shared login), fall back to generic **Staff** or **Unknown staff** — document limits for operators. |
| **Automated visibility** | Persist **outbound operational** messages initiated by ROS (in addition to Podium webhook mirror if available) so the profile shows **Automated** texts even if webhook coverage for outbound is partial. |

---

## Stub customers for unknown inbound numbers *(shipped behavior — **99**+ / **`podium_inbound`**)*

- **Find-or-create by phone**: On inbound webhook, normalize to **E.164**, then **`SELECT` existing customer by phone** before **`INSERT`**. Avoids duplicate rows for formatting variants.
- **Provenance**: Add a **persistent** field (e.g. `customers.created_source` = `manual` | `import` | `podium_inbound` | …) so reporting and UX stay honest; profile shows **Created from Podium SMS** (or similar) when applicable.
- **Minimal profile**: Name may be unknown — today `insert_customer` in `server/src/logic/customers.rs` uses **required** `first_name` / `last_name` strings; implementation can use **empty strings** if DB allows, or a **neutral placeholder** (e.g. `Text` / `Contact`) plus UI that displays **phone** and “Unnamed” until edited. Prefer a follow-up migration for **nullable display names** if product wants strict “no fake names” in the database.
- **Defaults**: **`marketing_sms_opt_in`** and **`marketing_email_opt_in`** = **false** until explicitly opted in; transactional reply policy remains separate from marketing.
- **Merge / dedupe**: When staff later identifies a duplicate or imports a real customer with the same phone, provide a **merge** or **link conversation** workflow so **SMS history** is not stranded on the stub profile.
- **Staff override**: If name capture fails or the customer sends something ambiguous, staff can set **first/last name** (and other fields) from the **profile** while in the **SMS** thread; notification labels then follow normal display rules.

### Unknown-sender welcome message & name capture *(product reference — verify against `podium_inbound` / template wiring in code)*

1. **Trigger**: After **find-or-create** for a **stub** customer (or any row meeting “no usable name” rules), and optionally only on **first inbound** in a time window to avoid spamming repeat texters — product decision; default conservative (once per conversation or once until name captured).
2. **Automated SMS** (class **Automated**): Template lives in the **SMS Module**; **default copy** (used until the shop edits it): *“Thank you for contacting RIverisde Men's Shop, please enter your first and last name and someone will be with you as soon as possibe, during regular business hours. Thank You”*. **Hours / send windows** for this template (e.g. only send during configured business hours vs anytime) are also configured in the **SMS Module** (or linked store hours).
3. **State**: Track **`awaiting_name_reply`** (or equivalent) on conversation or stub flags so parsers know the next customer message is a **name candidate**.
4. **Inbound parsing**: On the following message(s), attempt **lightweight extraction** (e.g. two tokens → first + last, or “Last, First” heuristics). On **low confidence**, store raw text in thread only and leave names for **staff**; on **high confidence**, update `customers.first_name` / `last_name`, clear awaiting flag, log as **Customer** message normally.
5. **Notifications**: Create the **SMS notification** when the **first** unknown inbound arrives; **display phone** until names are set. If parsing succeeds **before** staff **open** the notification, **update** the notification row / denormalized title so **both** the **SMS Module** list and **Notification Center** show the **new name** (client refetch or push).
6. **Tone**: Welcome SMS is a **direct reply** to their inbound message; default copy above is **non-promotional**; shops edit in the **SMS Module**.

---

## SMS Module (Back Office): templates + SMS notifications

**Location:** **Settings → Podium** for Podium connection and SMS. Operational email, reviews, receipt delivery, and storefront web chat live on their owning Settings pages. A future **shell SMS icon** that opens this module (or a deeper **SMS** tab) is still **Phase 5** per below.

### A — Automated message templates

**Requirement:** **All** automated SMS bodies that ROS sends via Podium (or any future provider) are **editable** here. Staff can update wording anytime; sends use the **stored template** at send time.

**Templates to include** (extend as new automations are added):

| Template key (indicative) | Trigger |
|---------------------------|--------|
| **Ready for pickup** | Order fulfilled / pickup-ready messaging (`MessagingService` pickup path) |
| **Alteration ready** | Alteration status → customer notify path |
| **Unknown-sender welcome** | First inbound from stub / unnamed contact (name-capture flow) |
| *(future)* | Any new operational or onboarding SMS |

**Features (product):**

- Per-template **textarea** (or rich text if ever needed; start plain text for SMS segments).
- **Reset to default** per template (restore shipped copy, e.g. the shop’s approved unknown-sender welcome string).
- **Placeholders (shipped):** customer identity, `{transaction_ref}`, `{alteration_ref}`, appointment date/time/type, and store identity values are available where relevant; `{order_ref}` remains a backward-compatible alias for saved pickup templates. The unknown-sender welcome template is wired to the inbound stub-customer reply flow.
- **RBAC (current):** **`settings.admin`** only for Podium/settings edits. Narrower **`sms.templates`** (TBD) still optional for later.

**Server / data (templates):**

- **Shipped:** templates live in **`store_settings.podium_sms_config`** JSONB (migration **70**), read by **`logic/messaging.rs`** and **`logic/podium.rs`** for sends. Code-level defaults fill empty stored values for pickup/alteration; unknown-sender default exists in code + UI **Reset** until inbound flow uses it.

### B — SMS notifications (Phase 4+)

- **In-module list:** The **SMS Module** includes a **Notifications** subsection (tab, panel, or stacked section) that lists **SMS notifications** (same rows as below).
- **Notification Center:** The shell **Notification Center** icon opens a panel that includes (at least) the **same SMS notification list** — one **API-backed feed**, two **UI surfaces**.
- **Alerts:** **Unread** SMS notifications drive an **alert** on **both** the **Notification Center** icon and the **SMS** icon/entry; implement via shared client state (counts from `GET` notifications) or equivalent.
- **Interaction:** Same as **Target UX**: tap/click → profile slideout → **SMS** thread.

---

## Podium platform prerequisites (operator checklist)

Per [Get Started](https://docs.podium.com/docs/getting-started):

1. **Developer account** at [developer.podium.com](https://developer.podium.com) (approval required).
2. **Create OAuth app** → note **Client ID** and **Client Secret** (secret not recoverable later).
3. **Scopes**: Riverside requests `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `read_contacts`, and `write_contacts` during OAuth. Podium must enable the matching products/scopes on the app; otherwise the hosted consent page may show a generic error or no data access details. Existing grants must reconnect after adding `read_contacts`.
4. **OAuth 2.0 authorization** so the app acts on behalf of a Podium org user:
   - Auth URL: `https://api.podium.com/oauth/authorize`
   - Token URL: `https://api.podium.com/oauth/token`
5. Obtain **`locationUid`** (or equivalent) for the store — first API call example in docs: `GET https://api.podium.com/v4/locations`.

### Saving Podium OAuth credentials (Settings UI)

1. In the Podium developer app, register **`https://ros.riversidemens.com/callback`** for production. Riverside displays that public callback even when staff initially open Settings from the Main Hub's LAN address, but OAuth remains gated until the browser is using the matching public origin because CSRF state and the Back Office session cannot cross origins. Loopback development continues to use **`${staff-app-origin}/callback`**; a different HTTPS deployment can set **`VITE_PODIUM_OAUTH_REDIRECT_URI`** (see **`client/.env.example`**).
2. Save the Podium **Client ID** and **Client Secret** in **Back Office → Settings → Integrations → Podium**.
3. **Back Office → Settings → Integrations → Podium → Connect Podium** (or **Connect Podium (refresh token)**). After authorization, the client route **`/callback`** exchanges the code **on the server** (client secret never in the browser) and saves the refresh token through the encrypted integration credentials endpoint.

The API accepts **`https://…/callback`** and loopback **`http://localhost|127.0.0.1…/callback`** for the authorize + exchange steps (see **`server/src/logic/podium.rs`**).

**API** (**`settings.admin`**): **`GET /api/settings/podium-oauth/authorize-url?redirect_uri=&state=`** (optional **`scope`**), **`POST /api/settings/podium-oauth/exchange`** with JSON **`{ "code", "redirect_uri" }`**.

Store **refresh token** (and access token + expiry) securely server-side; refresh before send (and before sync reads in later phases).

### Podium webhook registration

Podium must call a public Riverside API URL for webhooks; `localhost` is not valid for Podium-hosted delivery. For the current store tunnel pattern, register:

```text
https://ros.riversidemens.com/api/webhooks/podium
```

The same tunnel/public host must forward `/api/webhooks/podium` to the Rust API and `/callback` to the Vite/static client. When running locally, Cloudflare Tunnel or an equivalent HTTPS tunnel must stay running while testing OAuth callbacks and webhook deliveries.

Webhook registration is managed through Podium’s API using the saved OAuth credentials. Save the returned/assigned webhook signing secret in **Settings → Integrations → Podium** or `RIVERSIDE_PODIUM_WEBHOOK_SECRET`; production should reject unsigned webhook deliveries. Riverside uses the webhook for inbound message activity, Podium-side staff replies, `podium_message` persistence, inbox rows, notifications, and idempotent delivery tracking.

## ROS architecture

### Phases 0–2 (send + widget) — shipped

| Layer | Responsibility (as implemented) |
|--------|-----------------------------------|
| **`server/src/logic/podium.rs`** | OAuth refresh using encrypted integration credentials, cached token on **`AppState`**, `try_send_operational_sms` → **`POST {api_base}/v4/messages`**, structured errors / tracing |
| **`server/src/logic/messaging.rs`** | **SMS:** templates + Podium send when enabled (same gates as product). **Email:** operational HTML through the Store Email mailbox; the legacy Podium `email_send_enabled` setting is forced off. |
| **`server/src/logic/podium_webhook.rs`** | HMAC verification, idempotent **`podium_webhook_delivery`**; on accept, **`podium_inbound`** unless **`RIVERSIDE_PODIUM_INBOUND_DISABLED`** |
| **`server/src/api/webhooks.rs`** | **`POST /api/webhooks/podium`** (unsigned public route; verify via headers + secret) |
| **`AppState` / `main.rs`** | **`podium_token_cache`**; HTTP client shared with other integrations |
| **Store settings** | **`podium_sms_config`** JSONB: independent **`sms_features`**, legacy aggregate **`sms_send_enabled`**, **`location_uid`**, widget fields, operational **`templates`**, operational **`email_templates`**, **`review_templates`**, and **`receipt_templates`** |
| **Settings / deployment** | Routine Podium credentials live in Backoffice Settings. Deployment still owns the root encryption key and non-secret runtime flags such as **`RIVERSIDE_PODIUM_INBOUND_DISABLED`**. |

### Ingest, storage, CRM UI — **shipped** (**99**+); remaining polish

| Layer | Responsibility |
|--------|----------------|
| **Webhook + ingest** | **`podium_inbound::ingest_from_webhook`**: customer match/create for **inbound** traffic; **`podium_message`** with correct **`direction`**; **`podium_sender_name`** from webhook JSON when staff reply in Podium; **`podium_sms_inbound` / `podium_email_inbound`** notifications + fan-out **only for inbound** — see **`podium_inbound.rs`**. |
| **DB** | **`podium_conversation`**, **`podium_message`** (+ migration **71** webhook ledger; migration **104** **`podium_sender_name`**). |
| **`messaging.rs` / outbound** | Operational and staff sends persist the Podium message UID and raw provider response in `podium_message`, allowing exact provider reconciliation. |
| **API** | **`GET /api/customers/podium/messaging-inbox`**, **`GET /api/customers/podium/messaging-health`**, **`GET /api/customers/podium/messaging-unmatched`**, **`POST /api/customers/podium/messaging-sync`**, **`POST /api/customers/podium/direct-sms`**, **`GET/POST /api/customers/:id/podium/messages`**, notification **`read-all`**, etc. — **`customers.rs`**. |
| **Client** | **Operations → Inbox** (`PodiumMessagingInboxSection`); **Customer Relationship Hub → Messages** (Podium thread + reply); **Notification Center** deep links. |
| **Contact reconciliation** | Migration **187** adds durable outbound contact state/retry evidence, provider contact UID, append-only audit events, reconciliation runs/conflicts, collision-safe matching, manually audited unmatched-conversation resolution, full `read_contacts` reconciliation, and contact create/update/delete/merge/unchanged webhook handling. Only `settings.admin` can run a full reconciliation. It requires a location UID, permits one active run, and fails before absence/deletion handling when provider pages or contact identities cannot be proven complete. |
| **Still open / operational boundary** | Dedicated Settings thread browser and extra throttle/metrics remain optional polish. Deployment, OAuth reauthorization for `read_contacts`, public webhook delivery testing, and provider-side webhook enablement are operator actions; source validation alone does not prove them live. |

### Token lifecycle

- **Option A (recommended for server automation):** Long-lived **refresh token** from initial OAuth completion (one-time admin flow or small internal CLI) → server refreshes access token on a mutex/cached expiry (similar pattern to other OAuth integrations).
- **Option B:** Periodic manual token paste (fragile; avoid for production).

### Phone numbers

- Normalize to **E.164** before Podium API and before **find-or-create** customer (single shared helper).
- If normalization fails, log `warn!` and skip send (do not throw away order flow); for inbound, quarantine or log for manual resolution (product choice).

### Compliance

- Align message types with **shop policy**: pickup notices are **operational**; marketing blasts stay out of this path unless the business explicitly extends the product.
- Keep **`marketing_sms_opt_in`** as the gate for **marketing**; stub customers stay **opt-out** until changed.
- **`customers.transactional_sms_opt_in`** (migration **71**) gates **operational** texts independently from **`marketing_sms_opt_in`**; either flag allows pickup/alteration SMS when other send preconditions are met.

## Storefront widget (no OAuth required on ROS for basic embed)

Podium typically provides a **JavaScript snippet** (or tag manager instructions) from the **Podium dashboard** to show the **floating chat / text** control on any website.

| Task | Detail |
|------|--------|
| **Settings** | `settings.admin`: **Online Store** owns the **Enable Podium widget** toggle and snippet. **Podium** owns SMS templates and provider setup; the optional future SMS notifications list remains separate from storefront configuration. |
| **Storefront shell** | **`StorefrontEmbedHost`** + **`VITE_STOREFRONT_EMBEDS=true`** fetches **`GET /api/public/storefront-embeds`** once (keep flag **off** on staff/PWA builds). Dedicated public-store route may come with **`PLAN_ONLINE_STORE_MODULE.md`**. |
| **CSP** | See **`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`**; confirm live hostnames in Podium’s current embed snippet. |
| **Privacy** | Same doc — link store **privacy policy** to third-party chat (GDPR/CCPA as required). |

**Cost:** Included with Podium product; **no extra ROS hosting** cost beyond serving the page.

---

## Implementation phases

### Phase 0 — Widget on online store (fast win)

1. **Done:** Back Office widget toggle + snippet + public embed API + opt-in client host (**`VITE_STOREFRONT_EMBEDS`**).
2. **Open:** QA on staging domain Podium allows; CSP / privacy copy lives in **`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`** (operator checklist).

### Phase 1 — Send path (MVP)

1. **Done:** `logic/podium.rs`, env OAuth, token refresh, outbound send.
2. **Done:** Persistence + **`GET`/`PATCH /api/settings/podium-sms`** + Settings UI; all three template keys; unknown-sender **not sent** until Phase 3+.
3. **Done:** `trigger_ready_for_pickup` / `trigger_alteration_ready` use DB templates and Podium when enabled.
4. **Done:** `wiremock` test in **`server/src/logic/podium.rs`** (token + **`POST /v4/messages`** against **`RIVERSIDE_PODIUM_API_BASE`**). Order/alteration handlers still do not fail when Podium errors (fire-and-forget + log).

### Phase 2 — Observability & ops

1. **Done (logs):** `podium_send_ok`, `podium_send_err` with reason class; avoid logging phone/body on those paths.
2. **Open:** Optional local throttle / rate awareness for Podium limits; richer metrics if needed.

### Phase 3 — Webhooks & inbound foundation

1. **Done:** [Podium Webhooks](https://docs.podium.com/docs) — **`POST /api/webhooks/podium`**, signature verification, **`podium_webhook_delivery`** idempotency, **`podium_inbound`** CRM ingest (**99**+ threads + notifications; disable with **`RIVERSIDE_PODIUM_INBOUND_DISABLED`**).
2. **Done (core):** Inbound SMS/email → **find-or-create customer**, **`podium_message`**, notifications (**`podium_sms_inbound`** / **`podium_email_inbound`**), deep links — see **`podium_inbound.rs`**. Remaining **polish** in master plan (optional **`messaging.rs`** mirror rows, etc.).
3. Optional: delivery status webhooks for outbound correlation.
4. **Stub flow** (Phase 3/4): **welcome auto-reply** from unknown-sender template + **`awaiting_name_reply`** + **parser** (see **Unknown-sender welcome**).

### Phase 4 — Storage & automated message log

1. Schema: conversations/messages/notifications (exact shape TBD against Podium ids).
2. On ROS-initiated operational send, write **Automated** message row (and Podium message id when returned).
3. Backfill or sync historical messages if product requires (Podium “sync conversations” patterns).

### Phase 5 — Client: SMS Module notifications + Notification Center + profile thread

1. **SMS Module**: **Notifications** UI (same data as step 2) alongside **templates**.
2. Shell **Notification Center** + **SMS** icon: **shared SMS notification list**, **alert** on both when unread; row opens profile slideout → **SMS** section.
3. Thread UI with **Customer** / **Automated** / **Staff** badges; **opened** vs **responded** semantics.
4. RBAC: restrict who can view SMS notifications/threads and who can edit templates (align with existing `customers.*` / messaging / `settings.admin` — keys TBD).

### Phase 6 — Reply from ROS (optional)

1. Send reply via Podium API on existing conversation; attribute **Staff** when sent from ROS session.
2. Harden **merge** UX for stub ↔ full customer duplicates.

## Testing

- **Staging**: Podium test org + test credentials per their docs.
- **Automated:** `wiremock` Podium send-path test; webhook HMAC unit test; Playwright **Settings → Integrations → Podium** smoke (`client/e2e/podium-settings.spec.ts`).
- **Phase 4+**: Playwright for notification → profile deep-link and **SMS thread** UI when built.

## Documentation updates

- **`DEVELOPER.md`**: Settings-managed Podium credentials, runtime flags (**`VITE_STOREFRONT_EMBEDS`**, webhook/inbound toggles), API rows (**`/api/settings/podium/*`**, compatibility **`/podium-sms`**, **`/api/webhooks/podium`**, **`/api/public`**), migrations **70–71**, and the auth matrix for **`/api/public/storefront-embeds`** — updated.
- **`README.md`**, **`AGENTS.md`**, **`server/.env.example`**, **`.cursorrules`**, **`.cursor/cursorinfo.md`**, **`docs/PODIUM_STOREFRONT_CSP_AND_PRIVACY.md`**: migrations **70–71**, env names, file map — updated.
- **`docs/staff/settings-back-office.md`**: Integrations tab (weather + Podium) — updated.
- **`docs/PLAN_NOTIFICATION_CENTER.md`**: deferred checkbox clarifies **inbound** vs shipped **outbound** — updated.
- **Later (Phase 4+):** inbound SMS list/thread APIs, CRM thread docs when UI ships.

---

## Remaining work (after the “seven no-key” batch)

| Area | Still to build |
|------|----------------|
| **Inbound semantics** | Parse Podium webhook (and/or sync) payloads into **direction**, **body**, **phone**, **conversation id**; tie to **`customer_id`**. |
| **CRM storage** | Tables for **conversations** / **messages** (or equivalent), **Automated** outbound log for ROS-initiated sends. |
| **Customer stub flow** | Find-or-create by E.164, provenance field, unknown-sender **auto-reply**, name-capture parser. |
| **Staff UX** | **SMS module** list + **Notification Center** deep-link parity; **profile SMS thread** with badges; **reply-from-ROS**. |
| **RBAC** | Narrow keys (e.g. **`sms.templates`**) vs today’s **`settings.admin`** for Podium settings. |
| **QBO / ops** | Optional rate-limit metrics; optional **`GET /v4/locations`** validation tool for **`location_uid`**. |

## Risks

| Risk | Mitigation |
|------|------------|
| Token expiry / revoked refresh | Alert on repeated 401; admin re-auth flow documented |
| Wrong `locationUid` | Validate at startup with `GET /v4/locations` in admin setup script |
| PII in logs | Redact phone in non-debug traces; avoid logging full message bodies in production |
| Wrong customer link | **Find-or-create** by E.164; **merge** tooling; avoid relying on non-unique phone if duplicates exist in legacy data |
| Staff attribution gaps | Document **best-effort** mapping; generic **Staff** when Podium user ≠ ROS staff |
| Duplicate stub customers | Single **find-or-create** path; monitoring for same phone / multiple rows |
| Wrong name from SMS parse | **Heuristic only**; staff edit in profile; audit trail in thread |
| Auto-reply fatigue / wrong hours | Configurable template + **business hours** / send-once rules; rate-limit per conversation |

---

## References

- [Podium — Get Started](https://docs.podium.com/docs/getting-started)
- [Podium — OAuth 2](https://docs.podium.com/docs) (linked from Get Started)
- [Podium — Webhooks](https://docs.podium.com/docs) (signature verification, retries)
