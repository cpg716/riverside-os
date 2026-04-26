# Riverside OS POS Section Review (April 2026)

**Status:** Historical review snapshot. Use current POS, transactions, payments, and RMS Charge docs for canonical behavior.

This review covers the Point of Sale (POS) subsystem, focusing on checkout logic, hardware bridging, and offline resilience.

## 1. Checkout & Payment Ledger
- **Integer Cent Precision**: All and payment lines in the `NexoCheckoutDrawer` are stored and transmitted as integer cents.
- **Tender Engine**:
    - **Card**: Native Stripe reader intent logic with developement-mode simulation.
    - **Cash/Check**: Manual tender validation with change-due calculation.
    - **RMS Charge**: Store account charging with individual limit verification.
- **Deposit Management**: Handles mixed carts of takeaway (immediate payment) and special/wedding orders (ledger release).

## 2. Resilience and Reliability
- **Offline Queue**: Integrated `offlineQueue.ts` using `localforage`. Checkouts are persisted locally if the network is down and flushed automatically upon reconnection.
- **Idempotency**: Use of `checkout_client_id` ensures that multiple attempts to sync a single checkout do not result in duplicate orders.
- **Session Safety**: Reconciliation safeguards prevent closure of a register that has un-synced offline transactions.

## 3. Hardware Integration
- **Aural Feedback**: Sound profiles (Classic/Soft/Modern) provide scanning feedback without requiring visual screen contact.
- **Thermal Printing**: Direct TCP bridge for ZPL and ESC/POS raster modes. Connection diagnostic runs during the "Print" trigger to prevent hanging the UI.
- **Settings Persistence**: Terminal-specific IP/Port and Auto-print settings are stored in LocalStorage for persistence across Tauri app restarts.

## 4. Operational Aids
- **Morning Compass**: Analyzes wedding dates, task schedules, and notification counts to surface the "Next Best Action" for the salesperson at the start of the shift.
- **Manager Overrides**: Amber-tinted Manager Mode provides situational awareness of who has high-level permissions on the floor.

---
*Last Updated: 2026-04-08*
*Flight-Ready: Yes*
