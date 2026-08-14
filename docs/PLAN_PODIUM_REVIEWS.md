# Plan: Podium reviews (invites + Operations hub)

**Status:** **Fully implemented** — fulfilled Transactions automatically schedule an unbiased review request for **10:00 AM five days later**, using Podium **`POST /v4/reviews/invites`** plus tracked Podium SMS or Podium email delivery. The lifecycle includes a per-customer **180-day cooldown**, customer-level opt-out via `customers.review_requests_opt_out`, leased delivery claims, exact Podium message failure correlation, an audited manager cancellation boundary, a manager-only audited delivery test, **Operations → Reviews** published-review/response visibility plus Outbox/sent/failed invitation visibility, and background invite refresh.

**Depends on:** Podium OAuth (**`RIVERSIDE_PODIUM_*`**), **`podium_sms_config`** (**`location_uid`**, outbound toggles) — **[`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md)**. Receipt completion UX — **[`RECEIPT_BUILDER_AND_DELIVERY.md`](./RECEIPT_BUILDER_AND_DELIVERY.md)**.

**Podium API:** Review invite creation uses **`POST /v4/reviews/invites`**. Status refresh uses Podium review-invite rows when available. Scopes typically include review read/write permissions. **Do not reuse** invite URLs; generate a new invite per send per Podium guidance.

**Podium Inbox reliability:** inbound message, review-invite, published-review, and review-response webhooks update Riverside by event when Podium webhook delivery is configured. Attributed reviews appear in the matching Inbox conversation and use Podium's `needsResponse` state. A server background worker also pulls recent Podium conversations and review-invite status every **30 minutes** by default (`RIVERSIDE_PODIUM_SYNC_INTERVAL_SECS` can override, minimum 10 minutes); that pull does not backfill published reviews.

---

## Goals

1. **Post-sale review invites** for eligible native Riverside Transaction Records (status **fulfilled** / picked-up / takeaway). Historical Counterpoint imports are never eligible.
2. **Unbiased selection:** Scheduling remains automatic rather than cashier-selected. A staff member with **`reviews.manage`** may cancel an individual request only while it is still in the Outbox, with a required reason and Transaction activity audit.
3. **Trigger timing:** When a Transaction becomes **fulfilled**, schedule the invite for **10:00 AM five days later**; move Sunday targets to Monday.
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
- Transaction originated in Riverside OS. A record with **`is_counterpoint_import = true`** is historical reference data and must never schedule or send a review request.
- At least one non-internal line exists, and all non-internal lines are fulfilled.
- The Transaction Record has not already sent or suppressed a review request.
- The customer has not received a Riverside review invite in the last **180 days**.
- The customer has **`review_requests_opt_out = false`** (or NULL / not opted out).
- The customer has a valid phone number or email address.
- Podium credentials, location, and review permissions are configured.

---

## Receipt UI (POS)

- The completion receipt shows that an eligible review request is scheduled automatically.
- Closing, auto-closing, printing, or leaving the receipt does not control delivery, so an app interruption cannot silently lose the request.
- Customer opt-out status remains visible. Staff manage that preference in Customer Hub rather than making a per-sale positive-review selection.

---

## Trigger options

| Approach | Notes |
|--------|------|
| **Immediate checkout request** | Rejected: randomized field experiments found immediate reminders can reduce review posting likelihood through customer reactance. |
| **Five-day delayed job** | Shipped: preserves recall, avoids register pressure, and falls within the delayed 5–7 day windows tested in service/fashion field experiments. |
| **After the event date** | Not used globally because ordinary retail Transactions have no event date and a long delay weakens operational consistency. |

Decision: schedule at **10:00 AM store time five days after fulfillment**, moving Sunday delivery to Monday. See Jung et al., “Ask for Reviews at the Right Time: Evidence from Two Field Experiments,” *Journal of Marketing* 87(4), 2023, DOI `10.1177/00222429221143329`.

---

## Server (implemented)

- **`logic/podium_reviews.rs`** and **`logic/podium.rs`**: create invite via **`POST /v4/reviews/invites`**, map **`PodiumError`** to domain errors.
- **Routes:** **`POST /api/transactions/{id}/review-invite`** (staff/register-gated), review status surfaced in Operations.
- **Migration:** migration **`184_schedule_podium_review_invites.sql`** adds scheduled/claimed/attempt/error/channel/message-id state plus the fulfilled-Transaction scheduling trigger. Migration **`197_podium_review_activity.sql`** stores normalized published reviews and review responses while retaining verified provider payloads. Migration **`044_customer_review_opt_out.sql`** adds **`customers.review_requests_opt_out`**.

---

## Client (implemented)

- **`ReceiptSummaryModal`:** shows automatic scheduled status; no per-sale review gating.
- **Operations:** subsection **Reviews** shows published reviews, `needsResponse`, the latest Podium response, attribution-based customer/Transaction links, and the provider review link above **Outbox**, sent, failed, and cancelled/suppressed invitation filters. Scheduled rows have a reason-required **Cancel Invite** action for **`reviews.manage`**, and failed rows retain **Retry**. Cancellation is server-guarded to `scheduled` so a request already claimed as `sending` cannot be ambiguously cancelled. **Send Test** lets `reviews.manage` staff confirm the saved template and delivery path against a deliberately entered mobile number without creating a fake customer or Transaction; the acting staff member and masked destination are written to the operations action audit.
- **Customer hub:** Communication preferences includes **Opt out of review requests** checkbox; saved via **`PATCH /api/customers/{id}`**.

---

## Compliance / product

- Review solicitation uses the dedicated **`review_requests_opt_out`** preference on every automatic and manual entry point. It does not mutate marketing, operational SMS/email, or Podium campaign consent; unsubscribe handling remains separate for the underlying channel.
- Rate-limit and dedupe: at most one successfully sent invite per customer every **180 days**.
- Historical Counterpoint Transactions remain available for Transaction lookup and database audit, but are excluded from the Reviews workspace, scheduling trigger, manual scheduling entry points, delivery claim, and retry boundaries.
- Individual cancellation requires **`reviews.manage`**, a 12–500 character reason, and records the acting staff member in `transaction_activity_log`. It never recalls a request already handed to Podium.

---

## References

- Podium API reference: reviews, review invites (official docs).
- **[`docs/INTEGRATIONS_SCOPE.md`](./INTEGRATIONS_SCOPE.md)** — third-party posture.
