# Audit Report: Notification Center Subsystem
**Date:** 2026-04-08
**Status:** Highly Robust / Event-Driven
**Auditor:** Anti-gravity

## 1. Executive Summary
The Notification Center is the central nervous system of Riverside OS. It transforms system events (sync failures, discounts, inventory alerts) into actionable staff intelligence. The architecture is built for volume, with sophisticated deduplication and multi-channel targeting.

## 2. Technical Architecture

### 2.1 Storage & Inbox Model
- **Canonical Table**: `app_notification` stores the base message, payload, and audience rules.
- **Staff Inboxes**: `staff_notification` acts as a per-user delivery record, allowing individual "Read", "Complete", and "Archive" states.
- **Deduplication**: Uses a `dedupe_key` pattern. For example, a recurring QBO sync failure will not spam the inbox; it will update the existing notification timestamp instead of creating a new one.

### 2.2 Audience Targeting
The engine supports flexible targeting modes:
- **`all_staff`**: Mandatory broadcasts.
- **`roles`**: Targeting specific groups (e.g., only "Sales Support" for floor tasks).
- **`permission`**: Dynamic targeting (e.g., anyone with `qbo.view` receives accounting alerts).
- **`staff_ids`**: Manual, surgical targeting for order-specific updates.

### 2.3 Deep Linking
Every notification carries a `deep_link` JSON payload. This allows the frontend to navigate the user directly to the relevant record (e.g., clicking a "Low Stock" alert opens the specific Inventory Hub drawer).

## 3. Operational Hooks (Generators)
The system currently monitors and alerts on:
- **Financial**: QBO sync failures, Register cash discrepancies (over/short).
- **Inventory**: Catalog import skips/errors, Low-stock thresholds.
- **Customers**: Successful merges, Duplicate detection (pending).
- **Orders**: Full fulfillment alerts, Large discount overrides.

## 4. Maintenance & Retention
- **Stale Cleanup**: `archive_stale_staff_notifications` automatically clears old read alerts after 30 days.
- **Data Pruning**: `purge_archived_staff_notifications` manages database growth by deleting year-old records.

## 5. Findings & Recommendations
1. **Deduplication Strength**: The PostgreSQL `ON CONFLICT (dedupe_key)` implementation is a strong guard against notification fatigue.
2. **Channel Expansion**: The backend is ready for Push Notifications (WebPush/Tauri), though it currently relies on the in-app Bell + Toast system.
3. **Observation**: The link between "Notifications" and "Podium Messages" allows staff to see inbound SMS directly in their primary alert feed.

## 6. Conclusion
The Notification Center is a **mature, production-grade subsystem**. It successfully balances the need for real-time visibility with the risk of "alert noise" through its deduplication and permission-gated targeting.
