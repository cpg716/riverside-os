# Audit Report: Shipping & Labelling Subsystem (2026)
**Date:** 2026-04-08
**Status:** Multi-Carrier Support / Integrated

## 1. Executive Summary
The Shipping subsystem in Riverside OS is a unified hub that integrates with **Shippo** to provide multi-carrier logistics across the POS, Customer CRM, and public storefront. It supports real-time rate quoting, automated label purchasing, and a detailed tracking milestone timeline for every package.

## 2. Technical Architecture

### 2.1 Shippo Integration Engine
- **Carrier Rates**: `fetch_rates_for_shipment` generates multiple quotes (UPS, FedEx, USPS) based on a `ParcelInput` (dimensions and weight).
- **Label Purchasing**: `purchase_shipment_label` handles the financial transaction and transition of the shipment state to `label_purchased`.
- **Address Validation**: The system includes a defensive address-validation layer that surfaces Shippo's normalization errors directly to the operator.

### 2.2 Tracking & Milestones
- **Timeline**: Every shipment has a `shipment_events` history, recording everything from "Label Created" to "Out for Delivery" and "Delivered."
- **Staff Attribution**: All notes and state changes are recorded with the `staff_id` of the operator who performed the action.

## 3. Workflows & Lifecycle
- **Unified Hub**: Accessible from the **Customer Relationship Hub**, providing a complete shipping history alongside the customer's order history.
- **Manual Shipments**: Provides a "Manual Mode" for store-to-store transfers or local deliveries where tracking numbers and postage are handled outside Shippo but need to be recorded for compliance.
- **Postage Ledger**: Integrated with the system-wide ledger to ensure shipping costs are tracked against the correct orders for margin calculation.

## 4. Security & RBAC
- **`SHIPMENTS_VIEW`**: Required for reading tracking info.
- **`SHIPMENTS_MANAGE`**: Required for purchasing labels or manual state changes.

## 5. Findings & Recommendations
1. **Redundancy**: The "Force Stub" query parameter allows for testing rate-quoting workflows in development without exhausting real API credits.
2. **Error Recovery**: Shippo API errors are mapped to a specific `StatusCode::BAD_GATEWAY` to distinguish between internal Riverside failures and external provider outages.

## 6. Conclusion
The Shipping & Labelling subsystem is a robust, production-ready logistics hub that successfully abstracts the complexity of multi-carrier shipping into a single interface.
