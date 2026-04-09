# Audit Report: Stripe Integration
**Date:** 2026-04-08
**Status:** Highly Secure / Terminal-First
**Auditor:** Antigravity

## 1. Executive Summary
The Stripe integration in Riverside OS is built primarily for **Physical Retail (Card-Present)** using Stripe Terminal. It emphasizes security through server-side rate limiting and ensures a clean handoff between the POS terminal and the physical card reader.

## 2. Technical Implementation

### 2.1 Terminal Flow (`card_present`)
- **PaymentIntent Creation**: The backend creates `card_present` intents specifically for the store's physical readers.
- **Client Secret Handoff**: The server returns the `client_secret` to the frontend, which handles the secure handshake with the Stripe SDK (via the Tauri hardware bridge or browser).
- **Offline Simulation**: The engine includes a native "Simulation Mode" (triggered by the `offline_simulation` intent ID) allowing for development and floor testing without processing live financial transactions.

### 2.2 Security & Rate Limiting
- **Brute-Force Guard**: Implements a dedicated `payment_intent_max_per_minute` throttle. 
- **Staff-Only Access**: Every Stripe API call requires a valid Register Session or an authenticated Staff PIN, preventing unauthorized execution of payment intents.
- **Voiding Logic**: The system supports surgical `cancel_payment_intent` calls. If a staff member removes a card tender from the checkout drawer *before* finishing the sale, the server immediately voids the authorization on the reader to prevent hung transactions.

## 3. Webhook & Capture Logic
- **Transactional Capture**: Riverside OS uses a "Separate Auth and Capture" pattern. The intent is authorized on the reader and captured only when the `execute_checkout` transaction successfully commits to the database.
- **Deduplication**: Webhooks are processed with idempotency keys to ensure that a second "Payment Succeeded" event from Stripe doesn't create a duplicate ledger entry.

## 4. Findings & Recommendations
1. **Terminal Optimization**: The `card_present` specialization is perfect for the store's hardware-heavy environment.
2. **Rate Limit Precision**: The 60-second sliding window for request counts is a robust protection against API abuse.
3. **Observation**: The system uses a centralized `stripe_client` instance in `AppState`. **Recommendation**: Ensure the `RIVERSIDE_STRIPE_SECRET_KEY` is rotated periodically in accordance with the security policy.

## 5. Conclusion
The Stripe Integration is a **hardened, purpose-built module**. It prioritizes the reliability of physical terminal payments while maintaining strict server-side control over the payment lifecycle.
