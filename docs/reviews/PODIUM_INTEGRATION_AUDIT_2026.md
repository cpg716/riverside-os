# Audit Report: Podium Integration (2026)
**Date:** 2026-08-06
**Status:** Corrective implementation complete locally — production deployment and provider re-enable pending

> **Current delivery boundary:** Podium owns SMS/MMS, inbox sync, contacts, and both SMS/email delivery of review requests. Other customer operational email and email receipts use the first-party Store Email mailbox.

## 1. Executive Summary
The August 2026 audit found and corrected API-contract, delivery-truth, pagination, retry, and webhook-durability defects. Current source now follows Podium's documented contact and assignee payloads, creates and then delivers review links, records the channels that actually succeeded, and durably queues verified webhook JSON before returning `200`. These are local/source claims only: the Podium webhook remains provider-disabled, and the deployed Main Hub build must be replaced and publicly tested before inbound messaging is production-ready.

## 2. Technical Architecture

### 2.1 Multichannel Engine (`podium.rs`)
- **Transport**: Supports `SMS` (text), `MMS` (PNG attachments via multipart/form-data), and `Email` (HTML bodies).
- **Auth Strategy**: OAuth 2.0 with automatic token refresh logic. The server uses the Settings-managed encrypted refresh token to maintain a long-lived `PodiumTokenCache`.
- **Scopes**: `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `write_contacts`.

### 2.2 Inbound Webhook Ecosystem (`podium_webhook.rs`)
- **Security**: Mandatory HMAC-SHA256 signature verification and timestamp skew checks (<5 minutes).
- **Durability and idempotency**: `podium_webhook_delivery` stores verified JSON with pending/processing/processed/skipped/failed state. A leased worker retries database failures and reclaims interrupted processing without asking Podium to wait for CRM work.

## 3. Core Features

### 3.1 Automated Operational Messaging (`messaging.rs`)
- **Order Pickup**: Triggered asynchronously upon order fulfillment (`DbOrderStatus::Fulfilled`).
- **Alteration Ready**: Triggered when a work order is marked as ready.
- **Appointment Confirmations**: Automated emails sent upon creation of wedding/store appointments.
- **Loyalty Rewards**: SMS/Email notifications for reward issuance.

### 3.2 CRM & Relationship Hub (`podium_inbound.rs`)
- **Customer Matching**: Matches by E.164 phone tail or normalized email.
- **Stub Creation**: Automatically creates "New Contact" records for unrecognized senders with `podium_name_capture_pending = true`.
- **Smart Name Capture**: Monitors initial inbound bodies to automatically extract and update names.
- **Contact Sync**: Riverside uses Podium's documented `name`, `phoneNumber`, `email`, and `locations` fields for `POST /v4/contacts` and `PATCH /v4/contacts/{identifier}`. Automatic failures are logged instead of silently discarded.
- **Independent Review Suppression**: The Customer Hub review opt-out remains a Riverside review-only preference. It does not change Podium campaign unsubscribe state or the customer's SMS/email consent fields.

### 3.3 Staff Identity Mapping (`podium.rs` + `staff.rs`)
- **Podium User Fetching**: Cursor-paged `GET /v4/users`, merged with historical message senders. ROS does not send the undocumented `locationUid` users-list parameter.
- **Staff Dropdown**: `StaffEditDrawer` loads Podium users from `GET /api/staff/admin/podium-users` and saves `podium_user_uid` + `podium_display_name`.
- **Message Attribution**: Outbound and inbound messages now display staff names instead of raw UUIDs.

### 3.4 Conversation Management (`podium.rs`)
- **Assignees**: `GET /v4/conversations/{uid}/assignees` and documented `PUT /v4/conversations/{uid}/assignees` with `assigneeUids` for read/update.
- **Thread UI**: Inbox displays assigned users in the conversation header.

### 3.5 Visual Identity & Storefront (`StorefrontEmbedHost.tsx`)
- **Podium Widget**: Staff can configure the official Podium web chat snippet; the PWA injects it into public storefront pages (`/shop`).
- **MMS Receipts**: The POS can send a full thermal receipt as a PNG attachment directly via Podium's multipart attachment endpoint.

### 3.6 Review Invites (`podium_reviews.rs`)
- **API**: `POST /v4/reviews/invites` creates the provider review link. ROS then delivers that link through Podium SMS when a usable phone exists, or Podium email when email is the only usable destination.
- **Eligibility**: Fulfilled/picked-up sales, non-internal lines complete, 180-day cooldown per customer, valid contact info.
- **Customer Opt-Out**: `customers.review_requests_opt_out` boolean suppresses invites at the customer level.
- **Timing**: A Transaction entering `fulfilled` schedules delivery for 10:00 AM store time five days later (Monday when the fifth day is Sunday). This avoids an immediate checkout request while the experience is still fresh enough to recall.
- **Unbiased Selection**: Staff do not selectively send or suppress individual eligible sales. The store-wide enable switch and customer-level opt-out remain the explicit controls.
- **Status Tracking**: `review_invite_sent_at` is written only after the provider accepts delivery. `podium_review_invite_status` uses a leased `sending` claim, records the Podium message UID for exact `message.failed` correlation, exposes `scheduled` and `failed` rows in Operations, and refreshes provider review state in the background.

## 4. UI/UX Exposure
- **Operations → Inbox**: A team-wide view of all current Podium threads with auto-scroll, sent badges, and assignee display.
- **Customer Hub → Messages**: A full conversation history showing inbound, outbound, and `automated` messages; includes **Sync to Podium Contacts** button.
- **Customer Hub → Communication Preferences**: Review requests opt-out checkbox.
- **Staff → Edit**: Podium user dropdown for identity linking.
- **POS Receipt Summary**: Review invite controls honoring customer opt-out.

## 5. Security & RBAC
- **`NOTIFICATIONS_VIEW`**: Required for inbound message alerts.
- **`CUSTOMERS_HUB_VIEW`** / **`CUSTOMERS_HUB_EDIT`**: Inbox read/send.
- **`STAFF_EDIT`**: Podium user linking.
- **`SETTINGS_ADMIN`**: OAuth and scope configuration.
- **Settings Credentials**: Sensitive credentials (`CLIENT_SECRET`, `REFRESH_TOKEN`) are stored through Backoffice Settings encrypted integration credentials.

## 6. API Endpoint Coverage

| Endpoint | Method | Feature |
|---|---|---|
| `/v4/users` | GET, cursor-paged | Staff-to-Podium user matching |
| `/v4/messages` | POST | Outbound SMS and review-link delivery |
| `/v4/messages/attachment` | POST | Image attachments |
| `/v4/reviews/invites` | POST / GET, cursor-paged | Create review links and synchronize delivery state |
| `/v4/conversations` | GET | Inbox conversation list |
| `/v4/conversations/{uid}/messages` | GET, cursor-paged | Thread message history |
| `/v4/conversations/{uid}/read` | POST | Mark conversation as read |
| `/v4/conversations/{uid}/assignees` | GET / PUT | Show and update assignees |
| `/v4/contacts` | POST | Create Podium contact |
| `/v4/contacts/{identifier}` | PATCH | Update Podium contact |

## 7. Hardening (v0.70.x)

- **Retry Logic**: Safe reads retry network failures and HTTP 5xx. Reads and mutations honor HTTP 429/`Retry-After`, and a 401 invalidates the cached access token once. Mutating POSTs do not blindly retry ambiguous network/5xx outcomes, avoiding duplicate customer messages.
- **Health Check**: `GET /api/settings/podium-health` refreshes real OAuth credentials and checks the required `read_locations`, `read_messages`, `read_reviews`, and `read_users` surfaces. Delivery toggles and webhook processing remain separate readiness signals.
- **Endpoint Safety**: Settings accepts only official HTTPS `podium.com` service hosts; HTTP is restricted to loopback development.
- **Operational delivery truth**: Scheduled pickup/alteration work records `sms`, `email`, `both`, or `none` from actual successes. A provider failure no longer becomes a false delivered/both result.

## 8. Conclusion
The audited source defects are repaired and covered by targeted tests. Production is still gated on migration `183_podium_webhook_processing_queue.sql`, an exact-build deployment, a successful signed Podium test delivery, and provider-side webhook re-enable. The Podium developer app should also be reduced from its currently enabled broad scope set to the seven scopes ROS requests, after the deployed feature smoke test confirms the required grant.

**Last reviewed:** 2026-08-06
