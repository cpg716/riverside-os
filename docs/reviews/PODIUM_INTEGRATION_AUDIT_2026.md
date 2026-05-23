# Audit Report: Podium Integration (2026)
**Date:** 2026-05-23
**Status:** Complete — All Planned APIs Wired and Production-Ready

## 1. Executive Summary
The Podium integration in Riverside OS is a comprehensive, multi-channel communication engine that powers both automated operational messaging and manual CRM engagement. It features a sophisticated webhook ecosystem for inbound messaging, automatic customer matching/stub-creation logic, native support for sending thermal receipt images via MMS, and full bidirectional staff identity mapping. All major Podium API endpoints are now wired and in active use.

## 2. Technical Architecture

### 2.1 Multichannel Engine (`podium.rs`)
- **Transport**: Supports `SMS` (text), `MMS` (PNG attachments via multipart/form-data), and `Email` (HTML bodies).
- **Auth Strategy**: OAuth 2.0 with automatic token refresh logic. The server uses the Settings-managed encrypted refresh token to maintain a long-lived `PodiumTokenCache`.
- **Scopes**: `read_locations`, `read_messages`, `write_messages`, `read_reviews`, `write_reviews`, `read_users`, `write_contacts`.

### 2.2 Inbound Webhook Ecosystem (`podium_webhook.rs`)
- **Security**: Mandatory HMAC-SHA256 signature verification and timestamp skew checks (<5 minutes).
- **Idempotency**: A dedicated `podium_webhook_delivery` ledger ensures each Podium UID is processed exactly once.

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
- **Contact Sync**: Riverside customers are automatically pushed to Podium contacts on create and update via `POST /v4/contacts` and `PATCH /v4/contacts/{identifier}`.
- **Campaign Opt-Out**: When a customer opts out of review requests, Riverside syncs this to Podium via `POST /v4/contacts/{identifier}/campaigns/opt_out`.

### 3.3 Staff Identity Mapping (`podium.rs` + `staff.rs`)
- **Podium User Fetching**: `GET /v4/users` with location filtering, merged with historical message senders.
- **Staff Dropdown**: `StaffEditDrawer` loads Podium users from `GET /api/staff/admin/podium-users` and saves `podium_user_uid` + `podium_display_name`.
- **Message Attribution**: Outbound and inbound messages now display staff names instead of raw UUIDs.

### 3.4 Conversation Management (`podium.rs`)
- **Assignees**: `GET /v4/conversations/{uid}/assignees` and `PATCH /v4/conversations/{uid}/assignees` for read/update.
- **Thread UI**: Inbox displays assigned users in the conversation header.

### 3.5 Visual Identity & Storefront (`StorefrontEmbedHost.tsx`)
- **Podium Widget**: Staff can configure the official Podium web chat snippet; the PWA injects it into public storefront pages (`/shop`).
- **MMS Receipts**: The POS can send a full thermal receipt as a PNG attachment directly via Podium's multipart attachment endpoint.

### 3.6 Review Invites (`podium_reviews.rs`)
- **API**: `POST /v4/reviews/invites` fully wired.
- **Eligibility**: Fulfilled/picked-up sales, non-internal lines complete, 180-day cooldown per customer, valid contact info.
- **Customer Opt-Out**: `customers.review_requests_opt_out` boolean suppresses invites at the customer level.
- **Per-Sale Opt-Out**: Cashier can skip on the Receipt Summary modal.
- **Status Tracking**: `review_invite_sent_at`, `review_invite_suppressed_at`, `podium_review_invite_id`, `podium_review_invite_status` on `transactions`.

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
| `/v4/users` | GET | Staff-to-Podium user matching |
| `/v4/messages` | POST | Outbound SMS/email |
| `/v4/messages/attachment` | POST | Image attachments |
| `/v4/reviews/invites` | POST | Automated review requests |
| `/v4/conversations` | GET | Inbox conversation list |
| `/v4/conversations/{uid}/messages` | GET | Thread message history |
| `/v4/conversations/{uid}/read` | POST | Mark conversation as read |
| `/v4/conversations/{uid}/assignees` | GET / PATCH | Show and update assignees |
| `/v4/contacts` | POST | Create Podium contact |
| `/v4/contacts/{identifier}` | PATCH | Update Podium contact |
| `/v4/contacts/{identifier}/campaigns/opt_out` | POST | Campaign opt-out sync |

## 7. Conclusion
The Podium integration is an industrial-grade, fully wired system that bridges the point-of-sale and customer mobile devices. All planned API endpoints are implemented, staff identity is correctly mapped, customer opt-out preferences are respected end-to-end, and the UI reflects a modern iOS/Android messaging experience. No implementation gaps remain.
