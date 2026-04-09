# Plan: Constant Contact integration (Riverside OS)

**Status:** Not implemented — roadmap / future integration.

Implementation plan for syncing **marketing-eligible contacts** and **list/segment** placement between Riverside OS and **Constant Contact v3 API**, plus **one-way ingestion** of **marketing send/engagement events** so staff can see a **history on the customer profile** — without turning ROS into a full email builder.

**Reference docs:** [Constant Contact v3 API reference](https://developer.constantcontact.com/api_reference/index.html).

**Online store alignment:** **[`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)** §7 (signup embed, checkout opt-in).

**Customer Hub alignment:** Timeline today is built in **`server/src/api/customers.rs`** (`build_customer_timeline`) and consumed by **`CustomerRelationshipHubDrawer`** (`GET /api/customers/:id/timeline`). Marketing events would extend that model or a dedicated hub subsection; gate with **`customers.timeline`** (see **`docs/CUSTOMER_HUB_AND_RBAC.md`**).

---

## Goals

- **Outbound sync**: Push or upsert customers into Constant Contact **contact lists**, respecting **`marketing_email_opt_in`** and valid email addresses.
- **Segments / lists**: Map ROS signals (e.g. **VIP**, web vs in-store lists) to separate CC lists or tags when the API supports it — **list building in CC**, not campaign authoring in ROS.
- **Source of truth**: ROS remains authoritative for **consent** and **retail profile** fields; CC is the **campaign channel**.
- **No bidirectional CRM**: Do **not** sync CC contact edits back into ROS customer columns (name, email, consent). **Exception:** **CC → ROS** is allowed for **activity / telemetry** only (see § Customer profile history) — not for merging “who is this customer.”
- **Nightly reconcile**: Scheduled job to reduce drift (list membership vs ROS opt-in, missed webhooks, CC-side list edits) using batch API reads within rate limits.
- **Marketing email history in profile**: Persist **CC-reported** events (send, bounce, unsubscribe, etc.) and surface them on the **Relationship Hub** timeline (or a dedicated **Marketing** strip) so staff see what went out **without** claiming opens/clicks as ground truth everywhere.
- **Idempotent, batch-friendly** outbound operations to avoid N+1 API calls for large directories.
- **Secrets**: OAuth access + refresh tokens stored server-side only; documented env vars; webhook signing secret if CC provides it.

## Non-goals (initial phase)

- Building **email templates** or **campaign authoring** inside ROS (use Constant Contact UI).
- Replacing **`MessagingService`** transactional email placeholders in `messaging.rs` unless product explicitly wants CC for **transactional** mail (different API paths and compliance profile — usually keep transactional on Resend/SendGrid-style provider).
- Two-way **full CRM merge** (conflict resolution when CC contact fields are edited in CC UI) — **out of scope**; use reconcile only for **list membership** and **event log completeness**, not for overwriting ROS `customers.*`.

## Sync direction (summary)

| Direction | Data | Purpose |
|-----------|------|---------|
| **ROS → CC** | Contact upsert, list add/remove, opt-out | Campaign audience matches store consent and segments |
| **CC → ROS** | Webhooks + optional activity API poll | **Marketing event log** for customer timeline (not profile field merge) |

## Constant Contact platform prerequisites

Per typical v3 patterns (confirm in [API reference](https://developer.constantcontact.com/api_reference/index.html)):

1. **Developer application** + **API key** / **OAuth2** credentials in Constant Contact developer portal.
2. **Redirect URI** for OAuth if using authorization code flow for long-lived access.
3. Pre-create **list(s)** in CC (e.g. “ROS — Marketing opt-in”, “ROS — VIP”) or create via API if supported.
4. Understand **rate limits** and **bulk** endpoints for contact create/update.
5. **Webhooks** (or equivalent **contact activity** endpoints): confirm which events exist (send, bounce, unsubscribe, spam complaint, etc.) and whether **opens/clicks** are offered; configure **HTTPS** callback URL to ROS.

**Note:** Exact endpoint names and payload shapes must be taken from the current v3 reference when implementing; this plan stays vendor-agnostic at the ROS boundary.

## ROS architecture

| Layer | Responsibility |
|--------|----------------|
| **`server/src/logic/constant_contact.rs`** (new) | OAuth token handling, `upsert_contact`, `add_to_list`, batch helpers, **activity normalization**, error mapping |
| **`server/src/logic/constant_contact_webhook.rs`** (new, or submodule) | Verify signature (if applicable), idempotent ingest, map payload → `customer_id` |
| **`server/src/api/integrations_cc.rs`** or under **`settings` / `admin`** | Thin handlers: “sync now”, status, **`POST` webhook** (no staff headers; shared secret / HMAC only) |
| **Auth** | **`settings.admin`** or **`integrations.marketing`** for sync UI; webhooks **unauthenticated** to staff but **authenticated** via provider secret |
| **Job runner** | `tokio::spawn` for manual sync; **nightly reconcile** via external scheduler or internal cron hitting **`POST /api/.../reconcile`** (or dedicated job entry) |

### Data mapping (proposed) — ROS → CC

| ROS | CC |
|-----|-----|
| `customers.email` | Contact email (required for sync row) |
| `customers.first_name`, `last_name` | Contact name fields |
| `customers.phone` | Optional custom field or phone field if API supports |
| `customers.customer_code` | Custom field / external ID for dedupe and webhook matching |
| `marketing_email_opt_in == true` | Eligible for “marketing” list; `false` → remove from list or suppress via API |
| `is_vip` | Optional second list or tag |

### Consent enforcement

- **Never** sync contacts with `marketing_email_opt_in = false` into promotional lists.
- On **opt-out** in ROS (`PATCH /api/customers`), enqueue **remove** or **unsubscribe** in CC (API-dependent).

### Dedupe and webhook matching

- Prefer **email** as primary key for CC; store **`customer_code`** in a CC custom field to match when **email changes** and for **idempotent** webhook correlation when the payload includes custom fields.
- Webhook handler: resolve `customer_id` by **email** first, then by **customer_code** in payload if email differs or is absent — document edge cases (shared family email, etc.).

## Customer profile: marketing email history

**Problem:** ROS does not know an email was **sent** unless CC reports it. Logging only “we synced to list” is **not** a full send history.

**Approach:**

1. **Webhooks (primary)**: Subscribe to CC events that indicate **send**, **hard/soft bounce**, **unsubscribe**, **complaint**, etc. Persist each normalized row linked to **`customer_id`** when resolvable.
2. **Nightly reconcile (backfill)**: Call CC **contact activity** or reporting endpoints (per current v3 docs) to **fill gaps** if a webhook failed or was delayed; dedupe on provider **message/campaign id + event type + timestamp**.
3. **UI**: Merge events into **`GET /api/customers/:id/timeline`** as new `CustomerTimelineEvent` kinds (e.g. `marketing_email_sent`, `marketing_email_bounced`, `marketing_unsubscribed`) **or** add a compact **Marketing** subsection in **`CustomerRelationshipHubDrawer`** that reads the same store — avoid duplicating conflicting UX.
4. **RBAC**: Respect **`customers.timeline`** (and any future **`customers.marketing_activity`** key if product wants stricter gating).

**Opens / clicks:** Optional in v1. If stored, label as **approximate** in UI (MPP, prefetch); prioritize **send / bounce / unsubscribe** for compliance and support conversations.

### Schema (proposed)

New table, e.g. **`customer_marketing_email_event`** (names TBD at implementation):

- `id`, `customer_id` (nullable until resolved), `provider` (`constant_contact`), `event_type`, `occurred_at`, `campaign_id`, `campaign_name` (denormalized for display), `message_id` / external ids, `payload_digest` or raw JSON in a restricted column for support, `created_at`
- Unique constraint or dedupe key on `(provider, external_event_id)` when CC supplies one
- Index `(customer_id, occurred_at DESC)`

Optional: **`integration_sync_log`** remains useful for **sync jobs**; marketing events are **separate** from “last directory sync.”

## Storefront / online store integration

These complement **CRM sync** (above); they focus on **anonymous visitors** and **web buyers**.

| Surface | Behavior |
|---------|----------|
| **Embedded signup form** | Constant Contact UI generates **embed code** for a list (often **iframe** or script). Store in **`store_settings.cc_signup_embed`** (or block type `cc_signup` in [`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md) CMS). Render in footer, `/newsletter`, or post-checkout thank-you page. |
| **Sanitization** | Prefer **iframe** embed to reduce XSS risk; if raw HTML required, **strict allowlist** (tags/attrs) server-side before render. |
| **Checkout checkbox** | “Send me offers” on **web checkout** → if checked, **server** (async) calls CC API to add contact to **Web marketing** list; still respect **double opt-in** if CC list requires it. |
| **Segments** | Optional list **“Web subscribers”** vs **“In-store CRM sync”** for different automations. |
| **Cost** | CC subscription is separate; **ROS** adds no SaaS for the embed itself. |

## Implementation phases

### Phase 0 — Storefront embed (can parallel Phase 1)

1. Settings field for **signup embed** + render on public storefront (see § Storefront).
2. Document **CSP** / cookie implications if script-based.

### Phase 1 — OAuth + single contact upsert (proof of life)

1. Server-side OAuth (refresh token storage, encrypted at rest optional — start with env + file not in repo).
2. Implement `upsert_contact` + add to one fixed **list_id** from env.
3. Manual **POST** from Back Office (button in Settings) for **one** customer ID (debug).

### Phase 2 — Batch sync

1. Query: `SELECT id, email, ... FROM customers WHERE marketing_email_opt_in = true AND email IS NOT NULL AND email <> ''`.
2. Batch in chunks (e.g. 50–100) per CC bulk guidelines.
3. Progress logging; **dry-run** mode that only counts rows.

### Phase 3 — Opt-out propagation + nightly reconcile (lists)

1. On customer patch setting `marketing_email_opt_in = false`, call CC API to remove/unsubscribe (implement per v3 docs).
2. **Nightly reconcile job**: compare ROS opt-in set vs CC list membership (or per-contact state) in batches; fix drift (add/remove) with rate-limit aware backoff. **Does not** import CC profile edits into `customers`.

### Phase 4 — Segments (optional)

- Map **VIP**, **wedding_soon**-style flags to separate lists or tags if CC API supports tags/segments.

### Phase 5 — Marketing email history (CC → ROS)

1. Register **webhook** URL with CC; implement **`POST`** handler with **secret verification** and **idempotent** inserts into **`customer_marketing_email_event`**.
2. Resolve `customer_id` from email / `customer_code` custom field; queue or drop unresolved events with structured logging for ops.
3. Extend **`build_customer_timeline`** (or add **`GET /api/customers/:id/marketing-email-events`**) and surface in **Relationship Hub** (timeline or Marketing subsection).
4. **Nightly backfill** from CC activity/reporting APIs to fill webhook gaps; dedupe on provider ids.

## UI (Back Office)

- **Settings → Integrations → Constant Contact**: connection status, “Sync now”, last run time, last error (toast + persisted log row optional); webhook URL + “last webhook received” diagnostic if useful.
- **Customer Relationship Hub**: timeline entries or Marketing strip for CC events (send/bounce/unsubscribe; opens/clicks optional).
- **Zero-browser-dialog** invariant: use `ConfirmationModal` for “full directory sync”.

## Schema (optional)

- **`customer_marketing_email_event`** — see § Customer profile history.
- **`integration_sync_log`** table: `provider`, `started_at`, `finished_at`, `rows_ok`, `rows_err`, `error_summary` — for directory sync / reconcile jobs (separate from per-customer events).

## Testing

- **Sandbox** CC account if available.
- Mock HTTP tests for 401, 429, malformed email.
- Webhook tests: signature pass/fail, duplicate delivery idempotency, unknown email (no crash).

## Documentation

- `DEVELOPER.md`: env vars, OAuth setup, list IDs, webhook URL, reconcile schedule.
- `docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md`: one line that CC is optional marketing sync + activity log, not Lightspeed parity.
- `docs/CUSTOMER_HUB_AND_RBAC.md`: if new permission key for marketing activity visibility.

## Risks

| Risk | Mitigation |
|------|------------|
| API rate limits | Batching + backoff; reconcile in small windows |
| Email duplicates in CC | Custom field `customer_code` + documented cleanup |
| Consent lawsuits | Strict gate on `marketing_email_opt_in`; audit log of sync actions |
| Webhook gaps | Nightly activity backfill + dedupe |
| Opens/clicks misleading | Prefer send/bounce/unsubscribe; label optional engagement as approximate |

---

## References

- [Constant Contact v3 API reference](https://developer.constantcontact.com/api_reference/index.html)
