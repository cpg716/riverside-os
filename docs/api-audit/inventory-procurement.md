# Inventory / Procurement API Audit

## Scope

Inspected `/api/products`, `/api/inventory`, `/api/inventory/physical`, `/api/purchase-orders`, and `/api/order-lifecycle` route registrations, permission gates, receiving/physical inventory side effects, and inventory/procurement frontend consumers.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET/POST | `/api/products` | `server/src/api/products.rs` | Inventory workspace, product form | GET `catalog.view`; POST `catalog.edit` | Staff Access | POST yes | `products`, `product_variants`, category/vendor joins | Product tests exist | High | Product create affects catalog and pricing source. |
| GET | `/api/products/maintenance` | `products.rs` | Maintenance ledger | catalog/staff gate | Staff Access | No | maintenance/inventory tables | Not traced | Medium | Operational read. |
| GET | `/api/products/next-ros-skus` | `products.rs` | Product form/import | `catalog.view`/edit context | Staff Access | No | SKU sequence/catalog | Not traced | Medium | SKU allocation preview. |
| GET | `/api/products/control-board` | `products.rs`, `/api/inventory/control-board` | Inventory control board, variant search | Staff or POS session with catalog view | Staff/POS context | No | product/variant/inventory tables | Product tests exist | Medium | POS may read through session. |
| POST | `/api/products/bulk-update` | `products.rs` | Inventory bulk bar | `catalog.edit` | Staff Access | Yes | products/variants/audit | Not fully traced | High | Bulk catalog mutation. |
| POST | `/api/products/bulk-set-model` | `products.rs` | Inventory bulk bar | `catalog.edit` | Staff Access | Yes | product model fields | Not fully traced | High | Bulk model mutation. |
| POST | `/api/products/bulk-archive` | `products.rs` | Inventory bulk bar | `catalog.edit` | Staff Access | Yes | product archive flags | Not fully traced | High | Bulk visibility mutation. |
| POST | `/api/products/variants/bulk-mark-shelf-labeled` | `products.rs` | Label print flows | `catalog.edit` | Staff Access | Yes | variants shelf label timestamps | Not fully traced | Medium | Inventory labeling state. |
| POST | `/api/products/variants/bulk-web-publish` | `products.rs` | Online/inventory | `catalog.edit` | Staff Access | Yes | variants web flags | Not traced | Medium | Storefront visibility. |
| POST | `/api/products/import` | `products.rs` | Universal importer | `catalog.edit` | Staff Access | Yes | products/variants/import audit | Importer tests exist | High | Catalog import remains catalog-only. |
| POST | `/api/products/matrix/generate` | `products.rs` | Variation builder | `catalog.edit` | Staff Access | Yes | product variants | Not traced | High | Creates variant matrix. |
| PATCH | `/api/products/variants/{variant_id}/stock-adjust` | `products.rs` | Inventory adjustment UI | `catalog.edit` | Staff Access | Yes | inventory movement/variant stock | Not traced | Critical | Direct inventory quantity adjustment. |
| PATCH | `/api/products/variants/{variant_id}/pricing` | `products.rs` | Variations workspace | `catalog.edit` | Staff Access | Yes | variant pricing/shelf label | Product pricing tests exist | Critical | Price/cost changes. |
| GET | `/api/products/variants/{variant_id}` | `products.rs` | Product hub/POS | `catalog.view`/POS session | Staff/POS context | No | variants/products | Not traced | Medium | Product detail. |
| GET | `/api/products/{product_id}/po-summary` | `products.rs` | Product hub | procurement/catalog view | Staff Access | No | PO lines/receiving | Not traced | Medium | Procurement read. |
| POST | `/api/products/{product_id}/clear-retail-overrides` | `products.rs` | Product hub | `catalog.edit` | Staff Access | Yes | variant pricing | Not traced | High | Bulk price reset. |
| PATCH | `/api/products/{product_id}/model` | `products.rs` | Product master form | `catalog.edit` | Staff Access | Yes | products, variants cascade | Product model tests exist | Critical | Base price/cost/tax/category source. |
| GET | `/api/products/{product_id}/hub`, `/timeline`, `/variants` | `products.rs` | Product hub | `catalog.view`/procurement view | Staff Access | No | product/timeline/variant joins | Not traced | Medium | Rich catalog read. |
| PATCH/GET/POST/DELETE | `/api/products/{product_id}/web-*` | `products.rs`, `web_categories.rs` | Online store admin | online/catalog permissions | Staff Access | Yes for writes | web listing/media/category tables | Not traced | Medium | Storefront visibility/content. |
| GET | `/api/inventory/scan/{sku}` | `server/src/api/inventory.rs` | Scanner/POS inventory | Staff or POS session | Staff/POS context | No | variants/inventory lookup | Not traced | Medium | Scan resolution. |
| GET | `/api/inventory/scan-resolve` | `inventory.rs` | Scanner/POS inventory | `catalog.view` or POS session | Staff/POS context | No | variants/barcodes | Not traced | Medium | Scan resolution. |
| POST | `/api/inventory/batch-scan` | `inventory.rs` | Batch scanner | `catalog.edit` or POS session path per helper | Staff/POS context | No live stock mutation per DTO note | scan staging data | Not traced | High | Intended staged quantity must not mutate stock. |
| GET | `/api/inventory/recommendations` | `inventory.rs` | Inventory intelligence | `catalog.view` | Staff Access | No | inventory analytics | Not traced | Medium | Decision support. |
| GET | `/api/inventory/intelligence/{variant_id}` | `inventory.rs` | Inventory intelligence panel | `catalog.view`; cost gated by `inventory.view_cost` | Staff Access | No | inventory/cost/sales data | Not traced | Medium | Cost visibility risk. |
| GET | `/api/inventory/wedding-products` | `inventory.rs` | Wedding/POS product selection | `catalog.view` or POS session | Staff/POS context | No | products/variants | Not traced | Medium | Wedding product picker. |
| GET/POST | `/api/inventory/physical/sessions` | `server/src/api/physical_inventory.rs` | Physical inventory workspace | GET `physical_inventory.view`; POST `physical_inventory.mutate` | Staff Access | POST yes | physical inventory sessions | Physical inventory logic tests exist | Critical | Starts inventory count session. |
| GET | `/api/inventory/physical/sessions/active` | `physical_inventory.rs` | Physical inventory workspace | `physical_inventory.view` | Staff Access | No | physical inventory sessions | Not traced | Medium | Active session. |
| GET/PATCH/DELETE | `/api/inventory/physical/sessions/{id}` | `physical_inventory.rs` | Physical inventory workspace | view/mutate split | Staff Access | PATCH/DELETE yes | physical inventory sessions | Not traced | Critical | Session state changes. |
| POST/PATCH | `/api/inventory/physical/sessions/{id}/counts[...]` | `physical_inventory.rs` | Counting UI | `physical_inventory.mutate` | Staff Access | Yes | physical inventory counts | Logic tests exist | Critical | Count and variance data. |
| POST | `/api/inventory/physical/sessions/{id}/counts/{count_id}/accept` | `physical_inventory.rs` | Review UI | `physical_inventory.mutate` | Staff Access | Yes | counts/variance review | Not traced | Critical | Accepts variance. |
| GET/POST | `/api/inventory/physical/sessions/{id}/review`, `/move-to-review`, `/save`, `/publish` | `physical_inventory.rs` | Review/publish UI | view/mutate split | Staff Access | Publish mutates live stock | physical inventory, inventory adjustments | Logic tests exist | Critical | Publish changes inventory quantities. |
| GET/POST | `/api/purchase-orders` | `server/src/api/purchase_orders.rs` | Purchase order panel, operations | GET `procurement.view`; POST `procurement.mutate` | Staff Access | POST yes | purchase orders | PO tests exist | High | Creates PO draft. |
| POST | `/api/purchase-orders/direct-invoice` | `purchase_orders.rs` | Receiving/direct invoice | `procurement.mutate` | Staff Access | Yes | PO/invoice/receiving/freight | Not traced | Critical | Receiving/cost path. |
| GET | `/api/purchase-orders/receiving-events/{event_id}` | `purchase_orders.rs` | Receiving history | `procurement.view` | Staff Access | No | receiving events | Not traced | Medium | Receiving detail. |
| GET | `/api/purchase-orders/{po_id}` | `purchase_orders.rs` | Purchase order panel | `procurement.view` | Staff Access | No | PO detail | PO tests exist | Medium | PO detail. |
| POST | `/api/purchase-orders/{po_id}/lines` | `purchase_orders.rs` | Purchase order panel | `procurement.mutate` | Staff Access | Yes | PO lines | Not traced | High | Procurement line mutation. |
| POST | `/api/purchase-orders/{po_id}/submit` | `purchase_orders.rs` | Purchase order panel | `procurement.mutate` | Staff Access | Yes | PO status | PO tests exist | High | Commits draft PO. |
| POST | `/api/purchase-orders/{po_id}/receive` | `purchase_orders.rs` | Receiving bay | `procurement.mutate` | Staff Access | Yes | receiving events, inventory stock/reserved, costs/freight | PO tests exist | Critical | Inventory and cost mutation. |
| GET | `/api/purchase-orders/{po_id}/receiving-history` | `purchase_orders.rs` | Receiving bay | `procurement.view` | Staff Access | No | receiving history | Not traced | Medium | Receiving audit read. |
| GET | `/api/order-lifecycle/items` | `server/src/api/order_lifecycle.rs` | Orders lifecycle workbench | `orders.lifecycle_manage` or read gate | Staff Access | No | transaction lines/lifecycle | Not traced | High | Lifecycle management list. |
| POST | `/api/order-lifecycle/items/{transaction_line_id}/transition` | `order_lifecycle.rs` | Orders lifecycle workbench | `orders.lifecycle_manage` | Staff Access | Yes | transaction line lifecycle events/status | Not traced | Critical | Manual lifecycle repair. |
| POST | `/api/order-lifecycle/ntbo/create-po` | `order_lifecycle.rs` | NTBO queue | `orders.lifecycle_manage`/procurement | Staff Access | Yes | PO and transaction line links | Not traced | Critical | Creates procurement from lifecycle queue. |
| GET | `/api/order-lifecycle/weddings/{wedding_party_id}/readiness` | `order_lifecycle.rs` | Wedding readiness | `weddings.view`/lifecycle read | Staff Access | No | wedding/order lifecycle | Not traced | High | Readiness source. |

## Contract Notes

- Inventory stock changes must go through receiving, stock adjustment, physical inventory publish, or approved domain logic.
- Catalog import remains catalog-only and should not alter stock except through explicit stock-adjust or receiving paths.
- Cost visibility is permission-sensitive through `inventory.view_cost`.

## Permission Notes

- Catalog reads generally use `catalog.view`; mutations use `catalog.edit`.
- Procurement reads use `procurement.view`; PO create/submit/receive use `procurement.mutate`.
- Physical inventory splits `physical_inventory.view` and `physical_inventory.mutate`.
- POS sessions can read selected catalog/inventory lookup paths for register workflows.

## Mutation / Side Effect Notes

- Critical stock/cost writes are variant stock-adjust, variant pricing, product model edits, PO receive/direct invoice, physical inventory publish, and lifecycle-created PO.
- Lifecycle transition repair writes audit events and should not bypass receiving/pickup rules for risky transitions.

## Transaction / Idempotency Notes

- PO and physical inventory logic use explicit transactions in many handlers/logic functions.
- Follow-up should verify idempotency for receiving retries, direct invoice retries, physical inventory publish retries, and stock adjustment duplicate submits.

## Audit Trail Notes

- Product model edits include ROSIE/catalog audit tests.
- Receiving history and physical inventory session/count tables preserve operational evidence.
- Follow-up should confirm staff attribution on every stock/cost mutation.

## Test Coverage

- `server/src/api/products.rs` has pricing/model tests.
- `server/src/api/purchase_orders.rs` has PO tests.
- `server/src/logic/physical_inventory.rs` has physical inventory tests.
- Missing: endpoint-level RBAC tests and duplicate-retry tests around receiving and physical publish.

## Risks

- Critical: stock adjust, price/cost update, PO receive, direct invoice, physical publish, lifecycle transition/create PO.
- High: bulk catalog mutations, import, PO submit/line edits, batch scan contract drift.

## Recommended Follow-Up

- Add endpoint permission tests for catalog/procurement/physical inventory split.
- Add idempotency tests for PO receiving and physical inventory publish.
- Trace staff attribution and audit logs for every live-stock mutation.
- Add a contract test proving batch-scan staging does not mutate stock.

