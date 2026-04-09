# NuORDER Integration

**Audience:** Developers and warehouse operators syncing **wholesale** catalogs, **images**, and **purchase orders** from NuORDER.

**Purpose:** Document the NuORDER integration posture, technical architecture, and available synchronization workflows.

---

## Migrations

| # | File | What it adds |
|---|------|----------------|
| **109** | **`109_nuorder_integration.sql`** | **`store_settings.nuorder_config`** JSONB; **`vendors.nuorder_brand_id`**; **`nuorder_sync_logs`** history table; **`nuorder.manage`**, **`nuorder.sync`** permissions. |
| **110** | **`110_nuorder_hardening.sql`** | **`product_variants.nuorder_id`**; **`products.nuorder_last_image_sync_at`**; `created_count`/`updated_count` logging; **`nuorder_entity_map_log`** audit table. |

Apply with **`./scripts/apply-migrations-docker.sh`** or **`sqlx migrate run`**.

---

## Technical Architecture

The integration utilizes a dedicated **`NuorderClient`** in the server backend, implementing **OAuth 1.0 (One-Legged)** for secure communication with the NuORDER REST API.

### Key Components

- **`NuorderClient` (`server/src/logic/nuorder.rs`)**: Handle signatures, rate limiting, and HTTP requests. Enforces a strict **5-concurrent-call limit** using a `tokio::sync::Semaphore`.
- **`NuorderSync` (`server/src/logic/nuorder_sync.rs`)**: Business logic orchestrator for catalog (Parent/Variant upserts), media (URL mapping), and Order-to-PO conversion. Implements **SKU/UPC matching priority** and **smart image refresh** (syncing only when `nuorder_last_image_sync_at` is null).
- **`NuorderSettingsPanel` (`client/src/components/settings/NuorderSettingsPanel.tsx`)**: Management UI for admin credentials and manual sync triggers. Features a **real-time activity feed** with detailed created/updated statistics per sync.

---

## Synchronization Workflows

| Track | Logic | Trigger |
|-------|-------|---------|
| **Catalog Sync** | Pulls Names, SKUs, Descriptions, and Prices (Wholesale/MSRP). Resolves vendors by **Brand ID** first, then name. | Manual (Settings) |
| **Media Sync** | Fetches `nuorder_image_urls` and maps them to ROS media library for POS/Storefront display. | Manual (Settings) |
| **Order/PO Flow** | Converts NuORDER "Approved" orders into ROS "Pending Purchase Orders". Matches items by **NuORDER ID**, then **SKU**, then **UPC**. | Manual (Settings) |
| **Inventory Sync** | Pushes ROS "Available to Sell" (ATS) levels back to NuORDER to prevent overselling. | Manual (Settings) |

> [!NOTE]
> All sync operations are logged to the `nuorder_sync_logs` table. Staff members who trigger a sync are credited in the system audit logs. Notifications are emitted to the **Action Center** upon completion or failure.

---

## RBAC & Permissions

| Key | Default (seeded) | Typical use |
|-----|------------------|-------------|
| **`nuorder.manage`** | admin | Configure API credentials, brand mapping. |
| **`nuorder.sync`** | admin, sales_support | Trigger manual syncs for catalog/orders/inventory. |

---

## UI Access

- **Settings → Integrations → NuORDER**: Primary management console for credentials and sync status.
- **Vendor Hub**: Map ROS Vendors to NuORDER Brand IDs to enable sync targeting. Displays "Linked to NuORDER" badge when configured.
- **Product Hub**: Displays the associated NuORDER ID in the product header for synced items.
- **Action Center**: Receive real-time toast alerts and inbox notifications for sync status.

---

## Related docs

- **[`docs/INTEGRATIONS_SCOPE.md`](INTEGRATIONS_SCOPE.md)** — Canonical posture list.
- **[`docs/CATALOG_IMPORT.md`](CATALOG_IMPORT.md)** — Universal CSV importer posture.
- **[`DEVELOPER.md`](../DEVELOPER.md)** — Overall system architecture.

**Last reviewed:** 2026-04-08
