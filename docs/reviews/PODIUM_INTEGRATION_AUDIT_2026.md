# Audit Report: Podium Integration (2026)
**Date:** 2026-04-08
**Status:** Highly Robust / Post-Completion (Review API pending)

## 1. Executive Summary
The Podium integration in Riverside OS is a comprehensive, multi-channel communication engine that powers both automated operational messaging and manual CRM engagement. It features a sophisticated webhook ecosystem for inbound messaging, automatic customer matching/stub-creation logic, and native support for sending thermal receipt images via MMS.

## 2. Technical Architecture

### 2.1 Multichannel Engine (`podium.rs`)
- **Transport**: Supports `SMS` (text), `MMS` (PNG attachments via multipart/form-data), and `Email` (HTML bodies).
- **Auth Strategy**: OAuth 2.0 with automatic token refresh logic. The server uses a background-refreshed `refresh_token` from environment variables to maintain a long-lived `PodiumTokenCache`.

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

### 3.3 Visual Identity & Storefront (`StorefrontEmbedHost.tsx`)
- **Podium Widget**: Staff can configure the official Podium web chat snippet; the PWA injects it into public storefront pages (`/shop`).
- **MMS Receipts**: The POS can send a full thermal receipt as a PNG attachment directly via Podium's multipart attachment endpoint.

## 4. UI/UX Exposure
- **Operations → Inbox**: A team-wide view of all current Podium threads.
- **Customer Hub → Messages**: A full conversation history showing inbound, outbound, and `automated` messages.

## 5. Security & RBAC
- **`NOTIFICATIONS_VIEW`**: Required for inbound message alerts.
- **Environment Variables**: Sensitive credentials (`CLIENT_SECRET`, `REFRESH_TOKEN`) are restricted to the server environment.

## 6. Implementation Gaps & Recommendations
1. **Review API Wiring**: The actual outbound review invite API call needs to be wired once Podium provides the production endpoint (currently ROS ledger stubs).
2. **Staff Attribution**: Inbound messages sent via external Podium apps cannot be linked to a ROS `staff_id` unless sender names match roster precisely.

## 7. Conclusion
The Podium integration is an industrial-grade system that successfully bridges the gap between the point-of-sale and customer mobile devices.
