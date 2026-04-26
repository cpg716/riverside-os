# Plan: Shippo, Podium (CRM + reviews), notification semantics

**Status:** **Mixed completion tracker / historical rollout map.** Shippo POS / Shipments, Podium inbound CRM, shared notification read behavior, and review-policy foundations are shipped; Shippo web checkout labels, Shippo webhook ingestion, full historical Podium sync, and live Podium review-invite API remain deferred / roadmap. For current entry points, start with **[`CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md`](./CUSTOMER_MESSAGING_AND_NOTIFICATIONS.md)** and **[`SHIPPING_AND_SHIPMENTS_HUB.md`](./SHIPPING_AND_SHIPMENTS_HUB.md)**.

**Purpose:** Single **completion tracker** for the cross-cutting initiative: **Shippo** fulfillment, **Podium** operational + **two-way CRM messaging**, **notification center** behavior (broadcast / shared read / reminders), and **post-sale review** workflow.  
**Does not replace** detailed specs — pair with **[`SHIPPING_AND_SHIPMENTS_HUB.md`](./SHIPPING_AND_SHIPMENTS_HUB.md)**, **[`PLAN_SHIPPO_SHIPPING.md`](./PLAN_SHIPPO_SHIPPING.md)**, **[`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)**, **[`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md)**, **[`PLAN_PODIUM_REVIEWS.md`](./PLAN_PODIUM_REVIEWS.md)**, **[`PLAN_NOTIFICATION_CENTER.md`](./PLAN_NOTIFICATION_CENTER.md)**.

**Last reviewed:** 2026-04-08 (repo migrations **98**–**106**; content below: Shippo/Podium/reviews **98**–**100**; Podium sender column **104**; bug-report ceiling **103** — **`docs/PLAN_BUG_REPORTS.md`**; register EOD snapshot **105**; recognition reporting **106** — **`docs/REPORTING_BOOKED_AND_FULFILLED.md`**).

---

## Executive summary

| Track | Status | Notes |
|-------|--------|--------|
| **1. Online Store + Shippo web (FUTURE)** | **Done (docs + product lock)** | Banners in **`PLAN_ONLINE_STORE_MODULE.md`** and **`PLAN_SHIPPO_SHIPPING.md`**: paid web checkout, `rate_quote_id` on checkout, guest label purchase remain **deferred**; POS / BO / Shipments hub are the supported label path. |
| **2. Shippo POS + Shipments manager** | **Mostly shipped** | Rates + quotes (migrations **74**–**75**), **`purchase_label`** in **`logic/shippo.rs`**, **`POST /api/shipments/{id}/purchase-label`**, persistence on **`shipment`** / **`orders`**; migration **98** `shippo_rate_object_id`. **Shipments hub** + POS shipping modal patterns — **`SHIPPING_AND_SHIPMENTS_HUB.md`**. |
| **2b. Shippo webhook** | **Not shipped** | Env helper **`SHIPPO_WEBHOOK_SECRET`** exists; **no** `POST /api/integrations/shippo/webhook` in tree yet. |
| **2c. Orders workspace late-bound UX** | **Partial** | Server + hub support shipping; dedicated **Orders** tab UX for ship → rates → label may lag **Shipments** hub — verify product requirements in **`PLAN_SHIPPO_SHIPPING.md`**. |
| **3. Podium inbound + CRM** | **Shipped (core)** | Migration **99**: **`podium_conversation`**, **`podium_message`**, **`customer_created_source` `podium`**, name-capture flag. **104**: **`podium_message.podium_sender_name`** for Podium web/app replies (no ROS **`staff_id`**). **`podium_inbound.rs`** classifies **inbound** vs **outbound** webhooks: customer messages → find-or-create + notifications; staff-originated Podium sends → **`direction` `outbound`**, no “new customer SMS/email” fan-out, no stub customer on unmatched contact. **`podium_webhook.rs`** ingest; **`podium_messaging.rs`**; **Operations → Inbox**; **Relationship hub → Messages**; staff reply APIs. |
| **3b. Automated transactional rows** | **Partial** | Pickup/alteration/receipt flows in **`messaging.rs`** do not uniformly persist **`podium_message`** for every Podium send (hub replies / inbound do). Optional hardening: record outbound operational sends. |
| **4. Reviews (Operations + policy)** | **Partially shipped** | **`store_settings.review_policy`** (**100**), receipt **`POST /api/transactions/{id}/review-invite`**, **`ReceiptSummaryModal`** opt-out, **Operations → Reviews**, admin **`review_invite_sent`** notification (stub Podium review API — **`podium_review_invite_id`** placeholder). Real Podium review API TBD — **`PLAN_PODIUM_REVIEWS.md`**. |
| **5. Notifications (shared read + nudge)** | **Shipped** | Inbound Podium fan-out to staff with **`notifications.view`**; **`POST /api/notifications/by-notification/{id}/read-all`**; hourly **`messaging_unread_nudge`** for stale **`podium_*`**, **`review_*`** ( **`notifications_jobs.rs`** ); client hooks in **`NotificationCenterDrawer`**. |

---

## 1) Online Store + Shippo web — FUTURE (explicit deferral)

- [x] Document **FUTURE ADDITION** for paid **`/shop`** checkout, quote binding, post-payment label (**`PLAN_ONLINE_STORE_MODULE.md`**, **`PLAN_SHIPPO_SHIPPING.md`**).
- [x] Keep **`/api/store/shipping/rates`** as **estimate / supported-path alignment** only until checkout exists (see Online Store plan).

---

## 2) Shippo — POS, Back Office, Shipments

- [x] **`purchase_label`** (Shippo Transaction API) + error mapping — **`server/src/logic/shippo.rs`**
- [x] Persist tracking / label URL / Shippo IDs — **`orders`**, **`shipment`**, events via **`logic/shipment.rs`**
- [x] **Buy label** route — **`/api/shipments/{id}/purchase-label`** (**`shipments.manage`**)
- [x] **Rate id on shipment** after quote consumption — migration **98**
- [ ] **Webhook** — optional tracking updates (**deferred**)
- [ ] **Orders workspace** — late-bound shipping UX parity with plan (**verify** vs **Shipments** hub)

---

## 3) Podium — inbound, CRM, bidirectional messaging

- [x] Schema **99** — conversations, messages, `podium` provenance, RBAC seeds for reviews keys
- [x] Webhook path → **CRM ingest** (when enabled) — **`podium_webhook.rs`**, **`podium_inbound.rs`**
- [x] Find-or-create customer + welcome / name-capture policy
- [x] APIs — inbox, thread, reply (staff-auth) — under **`/api/customers/.../podium/...`**
- [x] Client — **Operations → Inbox**, hub **Messages**, deep links + **`notificationDeepLink`**
- [ ] **Settings → Integrations → Podium** — extend for review-related scopes when Podium API firm (**low priority**)
- [ ] **Every** automated **`messaging.rs`** send mirrored in **`podium_message`** (**optional** follow-up)

---

## 4) Reviews — Operations-first, Settings General = policy

- [x] **`review_policy`** JSONB — migration **100**; **`GET`/`PATCH /api/settings/review-policy`**
- [x] Order columns + **`POST /api/transactions/{id}/review-invite`** (idempotent choice)
- [x] **`ReceiptSummaryModal`** — per-sale opt-out / default from policy
- [x] **Operations → Reviews** — **`reviews.view`**; list rows API **`/api/reviews/invite-rows`**
- [x] Admin notification on stub **invite recorded**
- [ ] **Live Podium review invite API** — replace stub; **verify scopes** — **`PLAN_PODIUM_REVIEWS.md`**

---

## 5) Notification center — broadcast, shared dismiss, 18h nudge

- [x] Fan-out on **inbound** (customer-originated) Podium message to staff with **`notifications.view`** — outbound Podium staff replies do not enqueue **new customer SMS/email** notifications
- [x] **`mark_read_for_all_recipients`** + **`POST .../read-all`**
- [x] **18h** unread reminder job — deduped **`messaging_unread_nudge`**
- [x] Client — read-all when acting on Podium / review / nudge deep links

---

## 6) Suggested delivery order (historical)

Original phased rollout:

1. Docs + web stub  
2. Shippo labels + POS/Shipments  
3. Podium persistence + webhook + find/create  
4. Hub + inbox + reply  
5. Notifications shared read + nudge  
6. Reviews (stub → real API)

---

## 7) Risk / compliance (still applicable)

- **PII:** thread storage, screenshots, logs — avoid raw bodies in **`tracing::info`**; redact errors.
- **Consent:** transactional vs marketing; align with **`transactional_sms_opt_in`** / email flags and store policy.
- **Provider drift:** re-verify Podium webhook and review API contracts before expanding.
- **E2E:** inbox open → read-all; Shippo label happy path in test mode when feasible.

---

## Key files (quick map)

| Area | Paths |
|------|--------|
| Shippo | `server/src/logic/shippo.rs`, `server/src/api/shipments.rs`, `client/src/components/customers/ShipmentsHubSection.tsx`, `client/src/components/pos/PosShippingModal.tsx` |
| Podium send | `server/src/logic/podium.rs`, `server/src/logic/messaging.rs` |
| Podium inbound | `server/src/logic/podium_webhook.rs`, `server/src/logic/podium_inbound.rs`, `server/src/api/webhooks.rs` |
| CRM messaging | `server/src/logic/podium_messaging.rs`, `server/src/api/customers.rs` (podium routes) |
| Notifications | `server/src/logic/notifications.rs`, `server/src/logic/notifications_jobs.rs`, `server/src/api/notifications.rs`, `client/src/components/notifications/NotificationCenterDrawer.tsx`, `client/src/lib/notificationDeepLink.ts` |
| Reviews | `server/src/logic/podium_reviews.rs`, `server/src/api/reviews.rs`, `server/src/api/transactions.rs` (review-invite), `client/src/components/operations/ReviewsOperationsSection.tsx`, `client/src/components/pos/ReceiptSummaryModal.tsx`, `client/src/components/settings/SettingsWorkspace.tsx` (General policy) |
