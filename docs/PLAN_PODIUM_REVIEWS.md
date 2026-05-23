# Plan: Podium reviews (invites + Operations hub)

**Status:** **Fully implemented** — **`store_settings.review_policy`** (**100**), **`ReceiptSummaryModal`** opt-out / defaults, **`POST /api/transactions/{id}/review-invite`** using Podium **`POST /v4/reviews/invites`**, per-customer **180-day cooldown**, **customer-level opt-out** via `customers.review_requests_opt_out`, **Operations → Reviews** (**`reviews.view`**), provider status refresh, and admin **`review_invite_sent`** notification. **Tracker:** **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)**. **Gift / subset receipts** (print, email, text) share **`ReceiptSummaryModal`** with review UX — **`docs/RECEIPT_BUILDER_AND_DELIVERY.md`**.

**Depends on:** Podium OAuth (**`RIVERSIDE_PODIUM_*`**), **`podium_sms_config`** (**`location_uid`**, outbound toggles) — **[`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md)**. Receipt completion UX — **[`RECEIPT_BUILDER_AND_DELIVERY.md`](./RECEIPT_BUILDER_AND_DELIVERY.md)**.

**Podium API:** Review invite creation uses **`POST /v4/reviews/invites`**. Status refresh uses Podium review-invite rows when available. Scopes typically include review read/write permissions. **Do not reuse** invite URLs; generate a new invite per send per Podium guidance.

**Podium Inbox reliability:** inbound message webhooks update Riverside by event when Podium webhook delivery is configured. A server background worker also pulls recent Podium conversations every **30 hours** by default (`RIVERSIDE_PODIUM_SYNC_INTERVAL_SECS` can override, minimum 10 minutes). The Inbox screen refreshes the Riverside copy every minute while open and shows webhook / missed-history pull health.

---

## Goals

1. **Post-sale review invites** for eligible Transaction Records (e.g. status **fulfilled** / picked-up / completed — product-defined).
2. **Cashier opt-out** on the **receipt** step (`ReceiptSummaryModal`): default **send** review request unless staff checks **skip** (or inverse UX; keep POS-fast).
3. **Trigger timing:** Enqueue invite when the receipt flow **finishes** (modal close / “next guest”), not during tender. Optional: only after **print** or **email/text** success — decide in implementation (see tradeoffs in §4).
4. **Operations → Reviews:** Read reviews (sync or on-demand), **needs response** filter, deep link or in-app response if Podium API supports it.
5. **Customer profile:** Show **invite sent** metadata; link review thread or Podium UI when IDs exist; match by **`customer_id`** / phone / email used at invite time.
6. **Tracking:** Persist **`transaction_id`**, **`customer_id`**, **`invite_sent_at`**, channel, Podium invite/review ids; optional reporting views / Insights later.

---

## Non-goals (initial slice)

- Replacing **Podium Inbox** for all reputation workflows.
- Guaranteeing **Google** vs other surfaces (behavior is Podium + publisher-specific).
- Sending invites for **cancelled** or **unpaid** Transaction Records without explicit product rules.

---

## Eligibility rules

- Transaction Record has **`customer_id`**.
- Transaction status is **fulfilled**, which is the Riverside state used for completed / takeaway / picked-up sales.
- At least one non-internal line exists, and all non-internal lines are fulfilled.
- The Transaction Record has not already saved a sent or skipped review choice.
- The customer has not received a Riverside review invite in the last **180 days**.
- The customer has **`review_requests_opt_out = false`** (or NULL / not opted out).
- The customer has a valid phone number or email address.
- Podium credentials, location, and review permissions are configured.

---

## Receipt UI (POS)

- Toggle: **Send** / **Do not send**.
- On modal **close** / **Begin new sale:** if not suppressed, call **`POST /api/transactions/{id}/review-invite`** once. The server returns a staff-readable outcome such as sent, skipped by staff, skipped because the customer was asked in the last 180 days, skipped because the customer opted out of review requests, or skipped because contact information is missing.
- Persist suppression in **`transactions`** when cashier opts out **before** close.
- The frontend also checks **`customer_review_requests_opt_out`** on the transaction detail to hide the review invite UI when the customer has opted out.

---

## Trigger options

| Approach | Notes |
|--------|------|
| **On receipt modal dismiss** | Simple; matches “sale mentally complete.” |
| **After print / email / text success** | Stronger custodian signal; exclude if none of those actions taken unless still desired. |
| **Delayed job (minutes)** | Reduces perceived latency; must handle void/correction edge cases. |

Recommendation: **modal dismiss** + **idempotent** “invite already sent” guard; optionally add **Settings** flag for “require digital receipt sent.”

---

## Server (implemented)

- **`logic/podium_reviews.rs`** and **`logic/podium.rs`**: create invite via **`POST /v4/reviews/invites`**, map **`PodiumError`** to domain errors.
- **Routes:** **`POST /api/transactions/{id}/review-invite`** (staff/register-gated), review status surfaced in Operations.
- **Migration:** columns on **`transactions`**: **`review_invite_suppressed_at`**, **`review_invite_sent_at`**, **`podium_review_invite_id`**, **`podium_review_invite_status`**, **`podium_review_url`**. Migration **`044_customer_review_opt_out.sql`** adds **`customers.review_requests_opt_out`**.

---

## Client (implemented)

- **`ReceiptSummaryModal`:** opt-out checkbox + pass flag on close. Checks **`customer_review_requests_opt_out`** from transaction detail to hide UI when opted out.
- **Operations:** subsection **Reviews** with table + filters; RBAC key **`reviews.view`**.
- **Customer hub:** Communication preferences includes **Opt out of review requests** checkbox; saved via **`PATCH /api/customers/{id}`**.

---

## Compliance / product

- Align with **transactional** vs **marketing** consent if invites are SMS/email; reuse or extend **`transactional_sms_opt_in`** / email flags as product/legal requires.
- Rate-limit and dedupe: **one invite per order** unless product explicitly allows resend with manager permission.

---

## References

- Podium API reference: reviews, review invites (official docs).
- **[`docs/INTEGRATIONS_SCOPE.md`](./INTEGRATIONS_SCOPE.md)** — third-party posture.
