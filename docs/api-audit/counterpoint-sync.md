# Counterpoint Sync API Audit

## Scope

Inspected the Counterpoint machine-to-machine bridge routes under `/api/sync/counterpoint/*`, Back Office settings routes under `/api/settings/counterpoint-sync/*`, the migration workbench routes under `/api/settings/counterpoint-sync/workbench/*`, and bridge-related frontend/deployment references.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/sync/counterpoint/health` | `server/src/api/counterpoint_sync.rs` | Counterpoint bridge | Sync token when configured | M2M | No | sync health/config | Counterpoint tests exist | Medium | Bridge health check. |
| POST | `/api/sync/counterpoint/heartbeat` | `counterpoint_sync.rs` | Counterpoint bridge | `x-ros-sync-token` or bearer token when configured | M2M | Yes | bridge heartbeat/status | Not fully traced | High | Proves bridge liveness. |
| POST | `/api/sync/counterpoint/run-start` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | sync run ledger | Not fully traced | High | Starts sync run evidence. |
| POST | `/api/sync/counterpoint/snapshot-reconciliation` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | reconciliation/summary tables | Not fully traced | High | Import completeness evidence. |
| POST | `/api/sync/counterpoint/fidelity-diagnostics` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | diagnostics tables | Not fully traced | Medium | Bridge diagnostics. |
| POST | `/api/sync/counterpoint/request/ack`, `/ack-request`, `/request/complete` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | sync request tables | Not fully traced | High | Operator-request lifecycle. |
| POST | `/api/sync/counterpoint/customers` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | customers/import provenance | Not fully traced | Critical | Customer identity import. |
| POST | `/api/sync/counterpoint/inventory/preflight`, `/inventory` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | inventory staging/catalog/stock provenance | Not fully traced | Critical | Inventory import/validation. |
| POST | `/api/sync/counterpoint/category-masters` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | category master maps | Not fully traced | High | Category mapping source. |
| POST | `/api/sync/counterpoint/catalog/preflight`, `/catalog` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | products/variants/import provenance | Not fully traced | Critical | Catalog source import. |
| POST | `/api/sync/counterpoint/aliases/preflight`, `/aliases/persist` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | barcode aliases | Not fully traced | High | SKU/barcode resolution source. |
| POST | `/api/sync/counterpoint/normalization/preview`, `/normalization/reference/import` | `counterpoint_sync.rs` | Settings/bridge | Sync token/settings admin path | M2M/Staff | Import yes | normalization reference tables | Not fully traced | High | Import mapping quality. |
| POST | `/api/sync/counterpoint/gift-cards` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | gift card liability/history | Not fully traced | Critical | Liability import. |
| POST | `/api/sync/counterpoint/tickets` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | historical transactions/lines/payments | Not fully traced | Critical | Historical financial import. |
| POST | `/api/sync/counterpoint/store-credit-opening` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | store credit balances | Not fully traced | Critical | Customer balance import. |
| POST | `/api/sync/counterpoint/open-docs` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | open orders/layaways/deposits | Not fully traced | Critical | Go-live open liability/order import. |
| POST | `/api/sync/counterpoint/vendors`, `/vendor-items` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | vendors/vendor item maps | Not fully traced | High | Procurement source mapping. |
| POST | `/api/sync/counterpoint/loyalty-hist`, `/customer-notes` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | loyalty/customer timeline | Not fully traced | High | CRM history import. |
| POST | `/api/sync/counterpoint/sales-rep-stubs`, `/staff` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | staff/sales rep mapping | Not fully traced | High | Staff attribution provenance. |
| POST | `/api/sync/counterpoint/receiving-history` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | receiving history/provenance | Not fully traced | High | Procurement history import. |
| POST | `/api/sync/counterpoint/staging` | `counterpoint_sync.rs` | Counterpoint bridge | Sync token | M2M | Yes | staging batches/rows | Not fully traced | Critical | Staging ingest surface. |
| GET/PATCH/POST | `/api/settings/counterpoint-sync/*` | `counterpoint_sync.rs` | Counterpoint settings panel | `settings.admin` | Manager/Admin | Writes yes | sync status, maps, staging, issues | Not fully traced | Critical | Back Office controls for bridge state and map resolution. |
| GET/POST/PATCH | `/api/settings/counterpoint-sync/workbench/*` | `server/src/api/counterpoint_workbench.rs` | Counterpoint workbench UI | `settings.admin` | Manager/Admin | Writes yes | workbench state, SKU gaps, suggestions | Not fully traced | High | Guided migration workflow and AI suggestions. |

## Contract Notes

- M2M bridge routes accept `x-ros-sync-token` or bearer token when `AppState.counterpoint_sync_token` is configured.
- Settings routes are Back Office controlled and use `settings.admin`.
- Imported rows must preserve Counterpoint provenance and avoid overwriting ROS-native records incorrectly.

## Permission Notes

- Bridge routes are not staff-header based; they depend on deployment sync token configuration.
- Back Office settings and map/staging operations require `settings.admin`.

## Mutation / Side Effect Notes

- Critical imports include customers, catalog, inventory, tickets, gift cards, store credit opening balances, open docs, staff, and receiving history.
- Settings staging apply/reset/map edits can change go-live data quality and import outcomes.

## Transaction / Idempotency Notes

- Follow-up should verify each import endpoint has idempotent natural keys and replay-safe behavior.
- Staging apply/reset needs explicit transaction and lock verification.

## Audit Trail Notes

- Bridge requests include run/heartbeat/request lifecycle evidence.
- Follow-up should verify operator settings actions record staff id, reason where applicable, and before/after map values.

## Test Coverage

- `server/src/api/counterpoint_sync.rs` has targeted tests.
- Counterpoint GUI and E2E proof were validated in prior release work, but endpoint-level replay tests were not fully traced in this pass.

## Risks

- Critical: tickets, gift cards, store credit opening, open docs, catalog/inventory, staging apply.
- High: vendor/staff/alias mappings, bridge token deployment, workbench AI suggestion application.

## Recommended Follow-Up

- Add replay/idempotency tests for each M2M import route.
- Add settings-admin RBAC tests for reset/apply/map mutation routes.
- Document exact natural keys and conflict behavior per imported entity.
