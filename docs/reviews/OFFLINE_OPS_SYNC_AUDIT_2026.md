# Audit Report: Offline Operations & Sync Subsystem (2026)
**Date:** 2026-04-08
**Status:** Highly Resilient / Fault Tolerant

## 1. Executive Summary
Riverside OS includes a sophisticated "Offline-First" capability for the Point of Sale (POS), ensuring that floor operations can continue during Wi-Fi instability or API outages. It utilizes browser-based persistent storage (`localforage`) and a deferred "Replay" strategy to synchronize completed checkouts once connectivity is restored.

## 2. Technical Architecture

### 2.1 The Offline Queue (`offlineQueue.ts`)
- **Persistence Layer**: Built on top of **IndexedDB/WebSQL** via `localforage`. This ensures that queued checkouts are not lost if the browser tab is closed or the device is restarted.
- **Queue Logic**: Only **completed retail checkouts** are queued. Complex operations (e.g., creating a new wedding party or opening/closing a register session) are intentionally blocked without a live API to ensure data integrity.
- **Security**: The system uses `headersSafeForOfflinePersist` to strip sensitive authentication secrets while maintaining enough context to re-authenticate during the replay phase.

### 2.2 Replay & Idempotency
- **Flush Strategy**: The client listens for the browser's `online` event to automatically trigger a "Flush" of the pending queue.
- **Server Guardrails**: Each checkout payload includes a unique `checkout_client_id`. The server's `transaction_checkout.rs` uses this for **Idempotency**, ensuring that if a client retries a sync that was partially processed, no duplicate orders or double-payments are created.

## 3. Floor Visibility & Feedback
- **Header Indicators**: An `OfflineBanner` component provides top-of-screen status ("Offline Mode" vs "Connected") and a count of **Pending Syncs**.
- **User Warnings**: Staff are warned via the UI against clearing browser cache or cookies while a pending count remains.

## 4. Operational Playbook (Recommended)
- **Outage Protocol**: Shift to simple retail checkouts; avoid starting large special-order or wedding bookings until connectivity is restored.
- **Hand-off**: The pending sync count is a required check during manager hand-offs and shifts.

## 5. Security & Risk Analysis
- **PII Exposure**: Local storage of customer data is minimized to only what is necessary for the current cart.
- **Session Continuity**: The system successfully bridges the gap between an offline checkout and an online sync without requiring the staff member to re-enter their PIN for every queued item.

## 6. Conclusion
The Offline Subsystem is a critical production feature that provides high operational confidence. It allows Riverside OS to function as a native-feeling POS while maintaining the architectural benefits of a centralized cloud API.
