# Audit Report: Reports & Insights (2026)
**Date:** 2026-04-08
**Status:** Highly Robust / Phase 2 Complete

## 1. Executive Summary
The Riverside OS Reporting and Insights infrastructure is exceptionally mature, featuring a dual-layer architecture that balances operational speed with analytical flexibility. The system distinguishes strictly between **Booked** (sale date) and **Recognition** (fulfilled/shipment date) business logic, ensuring financial reporting integrity according to retail accounting standards.

## 2. Technical Architecture

### 2.1 Dual-Layer Strategy
- **Curated Reports (Back Office → Reports)**: A fixed library of high-performance Rust/SQL endpoints for common operational needs (Sales Pivot, Margin, Best Sellers).
- **Advanced Insights (Metabase)**: A fully embedded BI suite for ad-hoc data exploration and dashboarding, integrated via a secure JWT SSO proxy that allows embedding in the same-origin UI.

### 2.2 Reporting Basis Consistency
The system utilizes a canonical SQL expression (`ORDER_RECOGNITION_TS_SQL`) across all modules to calculate the "Recognition Instant":
- **Pickup**: `fulfilled_at`.
- **Ship**: Earliest of `label_purchased` or `in_transit`/`delivered` events.
- **Cancelled**: Explicitly excluded from recognition.

## 3. Key Subsystems

### 3.1 Pivot Engine (`/api/insights/sales-pivot` & `/margin-pivot`)
- **Dimensions**: Grouping by `brand`, `category`, `salesperson`, `customer`, and `date`.
- **Admin Isolation**: Margin data (incorporating frozen `unit_cost` from checkout) is strictly gated to the **Admin** role only.
- **Weather Integration**: Daily sales pivots automatically correlate with historical weather snapshots (via Visual Crossing) to provide environmental context for sales performance.

### 3.2 Commission & Payouts
- **Ledger**: Tracks `unpaid` (booked/open), `realized_pending` (completed/not-paid), and `paid_out` (finalized) commissions.
- **Finalization**: A dedicated transactional workflow marks lines as paid on the recognition clock, preventing double-payouts and ensuring accounting closure.

### 3.3 Inventory Velocity
- **Best Sellers**: Calculated based on units sold and net sales in the chosen window/basis.
- **Dead Stock**: Identifies on-hand variants with low/zero velocity in the period, providing total "Retail Value on Hand" for slow-moving inventory.

## 4. UI/UX Implementation
- **Reports Workspace**: A generic report runner supporting date ranges, basis selection, and **CSV download** for all curated reports.
- **Metabase Proxy**: Custom proxy logic strips security headers (X-Frame-Options) to enable seamless embedding while maintaining staff auth parity.
- **Data Catalog**: A comprehensive `AI_REPORTING_DATA_CATALOG.md` exists to document every endpoint and parameter, preparing the system for AI-assisted reporting (ROSIE).

## 5. Security & RBAC
- **`insights.view`**: Standard permission for non-sensitive analytics.
- **Admin Required**: Hard-coded gate for `margin-pivot` and cost-sensitive data.
- **`insights.commission_finalize`**: Separate key for the mutating commission payout workflow.

## 6. Recommendations
1. **Dynamic Visualizations**: While CSV download is supported, the curated reports UI is primarily tabular. Adding lightweight charts (sparklines/bars) for pivot summaries would improve immediate visibility.
2. **Scheduled Exports**: Implement background generation of "Morning Digest" reports as automated email notifications for owners (planned in `PLAN_NOTIFICATION_CENTER.md`).

## 7. Conclusion
The Reporting & Insights sections are state-of-the-art for a retail platform, offering high data integrity and a clear roadmap for further AI integration. No critical logic gaps were found during this audit.
