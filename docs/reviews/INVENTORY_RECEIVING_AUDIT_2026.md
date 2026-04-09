# Audit Report: Inventory & Receiving Subsystem (2026)
**Date:** 2026-04-08
**Status:** Performance Optimized / Highly Robust

## 1. Executive Summary
The Inventory subsystem in Riverside OS is a high-performance engine designed for high-volume retail. It features a sophisticated SKU/Matrix model, a robust universal importer, and a "Receiving Bay" workflow that emphasizes speed and data integrity via HID scanner integration and real-time QBO GL mapping.

## 2. Technical Architecture

### 2.1 SKU & Matrix Model
- **Relationship**: `products` (logical template) -> `product_variants` (physical SKU).
- **Matrix Generation**: Supports 1-3 dimensional axes (e.g., Size, Color, Fit). The backend automatically generates all combinations with distinct SKU patterns.
- **Search Ranking**: A core architectural feature is the **45-day sales window ranking**. The system scores search results by parent-product popularity, ensuring staff see high-turnover items at the top of fuzzy searches.

### 2.2 Universal CSV Importer
- **Identity Engine**: Uses `catalog_handle` (canonical ID from sources like NuORDER or Lightspeed) to group variants.
- **Auto-Provisioning**: Automatically creates missing **Vendors** and **Categories** with NYS-compliant defaults (e.g., `is_clothing_footwear = true` for tax exemptions).
- **Fuzzy Mapping**: Features defensive cell-mapping logic that identifies variants like `qoh`, `invenr`, or `item_sku` without strict header requirements.

## 3. The Receiving Bay (Fulfillment UX)
- **HID Scanner Optimization**: Custom detection layer differentiates between laser scanners (HID) and manual typing via character-interval analysis.
- **Eyes-Free Operation**: Integrates audit-triggering sound effects to allow receivers to focus on physical shipments rather than the screen.
- **Accounting Integration**: Real-time lookups into QuickBooks Online (QBO) provide staff with a "Glance" into where asset value and freight costs are landing.

## 4. Physical Inventory & Reconciliation
- **Blind Counting**: Implements strict blind counting where staff cannot see expected stock levels.
- **Variance Audit**: Specialized "Review" phase provides a total shrinkage vs. surplus summary before publishing to the live ledger.

## 5. Security & RBAC
- **`CATALOG_VIEW / EDIT`**: Master data management.
- **`PHYSICAL_INVENTORY_MUTATE / VIEW`**: Gates the count collection and publish phases.
- **`PROCUREMENT_VIEW`**: PO-only visibility.

## 6. Conclusion
The Inventory & Receiving subsystem is professionally engineered for speed and precision, successfully bridging physical scanning with financial accounting via QBO integration.
