# Riverside OS API Audit

Status: high-risk audit plus first remediation pass, 2026-06-06.

This directory documents the current Riverside OS API surface from the Rust Axum route registrations, selected handler permission gates, known frontend consumers, existing domain docs, and visible test coverage. The initial pass was documentation-only; the follow-up remediation pass fixed confirmed low-risk code/schema/test issues and updated the audit status.

## Scope

Inspected high-risk route families first:

- POS / Register: `/api/transactions`, `/api/sessions`, `/api/pos`
- Payments / Helcim: `/api/payments`, `/api/webhooks/card-events`, legacy alias `/api/webhooks/helcim`
- Accounting / QBO: `/api/qbo`, `/api/auth/qbo`
- Inventory / Procurement: `/api/products`, `/api/inventory`, `/api/inventory/physical`, `/api/purchase-orders`, `/api/order-lifecycle`
- Staff Access / Manager Access: `/api/staff`, `/api/auth`, auth middleware
- Weddings / Group Pay: `/api/weddings`
- Customers / CRM: `/api/customers`
- Fulfillment / Shipping: `/api/shipments`, `/api/store/shipping/rates`, `/api/webhooks/shippo`
- Reports / Insights / Metabase: `/api/insights`, Metabase proxy
- ROSIE AI: `/api/help/rosie/v1/*`, `/api/ai/visual/*`
- Counterpoint Sync: `/api/sync/counterpoint/*`, `/api/settings/counterpoint-sync/*`

## Source Files

Primary route map:

- `server/src/api/mod.rs`
- `server/src/api/transactions.rs`
- `server/src/api/sessions.rs`
- `server/src/api/payments.rs`
- `server/src/api/qbo.rs`
- `server/src/api/products.rs`
- `server/src/api/inventory.rs`
- `server/src/api/physical_inventory.rs`
- `server/src/api/purchase_orders.rs`
- `server/src/api/order_lifecycle.rs`
- `server/src/api/staff.rs`
- `server/src/api/weddings.rs`
- `server/src/api/customers.rs`
- `server/src/api/shipments.rs`
- `server/src/api/insights.rs`
- `server/src/api/help.rs`
- `server/src/api/webhooks.rs`
- `server/src/api/counterpoint_sync.rs`
- `server/src/api/counterpoint_workbench.rs`

Key auth and business-rule references:

- `server/src/middleware/mod.rs`
- `server/src/auth/pins.rs`
- `server/src/auth/permissions.rs`
- `server/src/logic/transaction_checkout.rs`
- `server/src/logic/qbo_journal.rs`
- `server/src/logic/helcim.rs`
- `server/src/logic/physical_inventory.rs`
- `server/src/logic/shippo.rs`

## Cross-Cutting Findings

- Auth is handler-level for most APIs. The top-level router applies rate limiting globally, but route-specific auth and RBAC are enforced inside handlers and selected route-specific middleware.
- POS checkout requires a valid register session token whose header session id matches the checkout payload `session_id`.
- Most sensitive Back Office mutations use explicit permission keys, especially `orders.*`, `qbo.*`, `payments.*`, `catalog.*`, `procurement.*`, `physical_inventory.*`, `staff.*`, and `weddings.*`.
- External webhooks are intentionally unauthenticated by staff headers and instead use provider verification or configured secrets.
- QBO staging now has explicit account mapping validation and balanced-payload validation before approval/sync.
- Financial, inventory, payment, and staff-access paths have meaningful transactions and audit logging in several high-risk handlers, but coverage is uneven and should be verified endpoint by endpoint.
- Follow-up remediation added a schema repair for `transaction_lines.discount_amount`, aligned ROSIE capabilities access with its documented contract, hardened Helcim card refund/reverse idempotency replay, and stabilized DB-backed product/procurement/checkout tests.
- Validation proof: `cargo test -p riverside-server` passes 300 server tests after remediation.

## Risk Register

The prioritized list is in `api-risk-register.md`. Highest-priority follow-up work is in `follow-up-work.md`.
