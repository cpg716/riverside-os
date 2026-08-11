# Audit Report: Podium Integration (2026)
**Date:** 2026-08-06
**Status:** Corrective source implementation updated 2026-08-09 — production deployment and live provider proof pending

> **Current delivery boundary:** Podium owns SMS/MMS, inbox sync, contacts, and both SMS/email delivery of review requests. Other customer operational email and email receipts use the first-party Store Email mailbox.

## 1. Executive Summary
The August 2026 audit found and corrected API-contract, delivery-truth, pagination, retry, and webhook-durability defects. Current source also reads Podium locations and webhook subscriptions, creates or updates Riverside's exact selected-location subscription, exposes the pinned API version, and enforces Podium's 30 MB attachment cap. These are local/source claims only: the deployed Main Hub build and live Podium account must still be publicly tested before inbound messaging is production-ready.

## 2. Technical Architecture

### 2.1 Multichannel Engine (`podium.rs`)
- **Transport**: Supports `SMS` (text), `MMS` (PNG attachments via multipart/form-data), and `Email` (HTML bodies).
- **Auth Strategy**: OAuth 2.0 with automatic token refresh logic. The server uses the Settings-managed encrypted refresh token to maintain a long-lived `PodiumTokenCache`.
- **Scopes**: `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `read_contacts`, `write_contacts`.

### 2.2 Inbound Webhook Ecosystem (`podium_webhook.rs`)
- **Security**: Mandatory HMAC-SHA256 signature verification and timestamp skew checks (<5 minutes).
- **Durability and idempotency**: `podium_webhook_delivery` stores verified JSON with pending/processing/processed/skipped/failed state. A leased worker retries database failures and reclaims interrupted processing without asking Podium to wait for CRM work.

## 3. Core Features

### 3.1 Automated Operational Messaging (`messaging.rs`)
- **Order Pickup**: Triggered asynchronously upon order fulfillment (`DbOrderStatus::Fulfilled`).
- **Alteration Ready**: Triggered when a work order is marked as ready.
- **Appointment Confirmations**: Automated emails sent upon creation of wedding/store appointments.
- **Loyalty Rewards**: No automated Podium/Store Email send; customer notice remains the physical loyalty-letter workflow.

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
- **Unbiased Scheduling**: Eligible sales schedule automatically. Individual cancellation is restricted to **`reviews.manage`**, requires a reason, and writes the staff identity and reason to the Transaction activity log.
- **Audited Delivery Test**: **Operations → Reviews → Send Test** requires **`reviews.manage`**, uses the saved review template and configured Podium path, and writes the acting staff member plus masked destination to `ops_action_audit`. It does not create a customer or Transaction and does not enter the normal review cadence.
- **Status Tracking**: `review_invite_sent_at` is written only after the provider accepts delivery. `podium_review_invite_status` uses a leased `sending` claim, records the Podium message UID for exact `message.failed` correlation, exposes Outbox, cancelled, and failed rows in Operations, and refreshes provider review state in the background. Cancellation is accepted only from `scheduled`; `sending`, sent, and delivered activity cannot be recalled.

## 4. UI/UX Exposure
- **Operations → Inbox**: A team-wide view of all current Podium threads with auto-scroll, sent badges, and assignee display.
- **Customer Hub → Messages**: A full conversation history showing inbound, outbound, and `automated` messages; includes **Sync to Podium Contacts** button.
- **Customer Hub → Communication Preferences**: Review requests opt-out checkbox.
- **Staff → Edit**: Podium user dropdown for identity linking.
- **POS Receipt Summary**: Review invite controls honoring customer opt-out.
- **Settings ownership**: Podium owns connection/location/webhooks/SMS; Email owns operational email wording; Customer Reviews owns review policy/wording; Receipt Settings owns delivery captions/subjects; Online Store owns web chat.

## 5. Security & RBAC
- **`NOTIFICATIONS_VIEW`**: Required for inbound message alerts.
- **`CUSTOMERS_HUB_VIEW`** / **`CUSTOMERS_HUB_EDIT`**: Inbox read/send.
- **`STAFF_EDIT`**: Podium user linking.
- **`SETTINGS_ADMIN`**: OAuth and scope configuration.
- **`REVIEWS_VIEW`** / **`REVIEWS_MANAGE`**: Review-request history and reason-audited Outbox cancellation.
- **Settings Credentials**: Sensitive credentials (`CLIENT_SECRET`, `REFRESH_TOKEN`) are stored through Backoffice Settings encrypted integration credentials.

## 6. API Endpoint Coverage

| Endpoint | Method | Feature |
|---|---|---|
| `/v4/users` | GET, cursor-paged | Staff-to-Podium user matching |
| `/v4/locations` | GET, cursor-paged | Provider-backed location selection |
| `/v4/webhooks` | GET / POST | Inspect and create the Riverside subscription |
| `/v4/webhooks/{uid}` | PUT | Enable/update the exact URL/location subscription |
| `/v4/messages` | POST | Outbound SMS and review-link delivery |
| `/v4/messages/attachment` | POST | Image attachments |
| `/v4/reviews/invites` | POST / GET, cursor-paged | Create review links and synchronize delivery state |
| `/v4/conversations` | GET | Inbox conversation list |
| `/v4/conversations/{uid}/messages` | GET, cursor-paged | Thread message history |
| `/v4/conversations/{uid}/assignees` | GET / PUT | Show and update assignees |
| `/v4/contacts` | POST | Create Podium contact |
| `/v4/contacts/{identifier}` | PATCH | Update Podium contact |

## 7. Hardening (v0.70.x)

- **Retry Logic**: Safe reads retry network failures and HTTP 5xx. Reads and mutations honor HTTP 429/`Retry-After`, and a 401 invalidates the cached access token once. Mutating POSTs do not blindly retry ambiguous network/5xx outcomes, avoiding duplicate customer messages.
- **Health Check**: `GET /api/settings/podium/health` refreshes real OAuth credentials and checks the required `read_locations`, `read_messages`, `read_reviews`, `read_users`, and `read_contacts` surfaces. Delivery toggles and webhook processing remain separate readiness signals.
- **Endpoint Safety**: Settings accepts only official HTTPS `podium.com` service hosts; HTTP is restricted to loopback development.
- **Operational delivery truth**: Scheduled pickup/alteration work records `sms`, `email`, `both`, or `none` from actual successes. A provider failure no longer becomes a false delivered/both result.

## 8. Conclusion
The audited source defects are repaired and covered by targeted tests. Production remains gated on an exact-build deployment, the provider-side registration action, successful signed Podium deliveries, and real send/receive/contact/review smoke tests. The Podium developer app should be limited to the eight scopes ROS requests after the deployed feature smoke test confirms the grant.

**Last reviewed:** 2026-08-09
