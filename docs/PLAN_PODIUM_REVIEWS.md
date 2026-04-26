# Plan: Podium reviews (invites + Operations hub)

**Status:** **Partially implemented roadmap/deep spec** — **`store_settings.review_policy`** (**100**), **`ReceiptSummaryModal`** opt-out / defaults, **`POST /api/transactions/{id}/review-invite`** (stub Podium path + idempotency fields), **Operations → Reviews** (**`reviews.view`**), admin **`review_invite_sent`** notification. Start with **[`CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md`](./CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md)** for the documentation map. **Live Podium review-invite API** (replace stub) and response workflows remain **roadmap**. **Tracker:** **[`PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`](./PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md)**. **Gift / subset receipts** (print, email, text) share **`ReceiptSummaryModal`** with review UX — **`docs/RECEIPT_BUILDER_AND_DELIVERY.md`**.

**Depends on:** Podium OAuth (**`RIVERSIDE_PODIUM_*`**), **`podium_sms_config`** (**`location_uid`**, outbound toggles) — **[`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md)**. Receipt completion UX — **[`RECEIPT_BUILDER_AND_DELIVERY.md`](./RECEIPT_BUILDER_AND_DELIVERY.md)**.

**Podium API (verify against current docs):** Review invite creation (e.g. **Create a review invite link**), listing/fetching reviews, responses. Scopes typically include **`read_reviews`** / **`write_reviews`** (not payments). **Do not reuse** invite URLs; generate a new invite per send per Podium guidance.

---

## Goals

1. **Post-sale review invites** for eligible orders (e.g. status **fulfilled** / picked-up / completed — product-defined).
2. **Cashier opt-out** on the **receipt** step (`ReceiptSummaryModal`): default **send** review request unless staff checks **skip** (or inverse UX; keep POS-fast).
3. **Trigger timing:** Enqueue invite when the receipt flow **finishes** (modal close / “next guest”), not during tender. Optional: only after **print** or **email/text** success — decide in implementation (see tradeoffs in §4).
4. **Operations → Reviews:** Read reviews (sync or on-demand), **needs response** filter, deep link or in-app response if Podium API supports it.
5. **Customer profile:** Show **invite sent** metadata; link review thread or Podium UI when IDs exist; match by **`customer_id`** / phone / email used at invite time.
6. **Tracking:** Persist **`order_id`**, **`customer_id`**, **`invite_sent_at`**, channel, Podium invite/review ids; optional reporting views / Insights later.

---

## Non-goals (initial slice)

- Replacing **Podium Inbox** for all reputation workflows.
- Guaranteeing **Google** vs other surfaces (behavior is Podium + publisher-specific).
- Sending invites for **cancelled** or **unpaid** orders without explicit product rules.

---

## Eligibility rules (proposal)

- Order has **`customer_id`** (or phone/email for walk-in edge case — product choice).
- Order status in allowed set (configurable store setting or hard-coded enum).
- **`review_invite_suppressed`** (or equivalent) not set on the order for this checkout.
- Podium **credentials** + **location** + review-capable account; **`write_reviews`** (or documented equivalent) granted on the developer app.

---

## Receipt UI (POS)

- Toggle: **“Send review request”** (checked by default) or **“Skip review request”** (unchecked by default — pick one pattern and stick to it).
- On modal **close** / **Begin new sale:** if not suppressed, enqueue server job or call **`POST`** API once (idempotent per **`order_id`**).
- Persist suppression in **`orders`** (or side table) when cashier opts out **before** close.

---

## Trigger options

| Approach | Notes |
|--------|------|
| **On receipt modal dismiss** | Simple; matches “sale mentally complete.” |
| **After print / email / text success** | Stronger custodian signal; exclude if none of those actions taken unless still desired. |
| **Delayed job (minutes)** | Reduces perceived latency; must handle void/correction edge cases. |

Recommendation: **modal dismiss** + **idempotent** “invite already sent” guard; optionally add **Settings** flag for “require digital receipt sent.”

---

## Server (proposal)

- **`logic/podium_reviews.rs`** (or extend **`podium.rs`**): create invite, list reviews, post response wrappers; map **`PodiumError`** to domain errors.
- **Routes:** e.g. **`POST /api/transactions/{id}/review-invite`** (staff/register-gated), **`GET /api/podium/reviews`** (Operations), webhooks extension if Podium emits review events (TBD).
- **Migration:** columns on **`orders`**: **`review_invite_suppressed_at`**, **`review_invite_sent_at`**, **`podium_review_invite_id`** (nullable); optional **`podium_review_id`** when review received and correlated.

---

## Client (proposal)

- **`ReceiptSummaryModal`:** opt-out checkbox + pass flag on close or PATCH order once.
- **Operations:** new subsection **Reviews** (lazy tab); table + filters; RBAC key e.g. **`reviews.view`** / **`reviews.manage`** (seed in **`staff_role_permission`**).
- **Customer hub:** timeline row or badge “Review invite sent”; link to Operations or Podium.

---

## Compliance / product

- Align with **transactional** vs **marketing** consent if invites are SMS/email; reuse or extend **`transactional_sms_opt_in`** / email flags as product/legal requires.
- Rate-limit and dedupe: **one invite per order** unless product explicitly allows resend with manager permission.

---

## References

- Podium API reference: reviews, review invites (official docs).
- **[`docs/INTEGRATIONS_SCOPE.md`](./INTEGRATIONS_SCOPE.md)** — third-party posture.
