# Fulfillment / Shipping API Audit

## Scope

Inspected `/api/shipments`, POS and public store shipping-rate paths, Shippo webhook handling, shipment frontend consumers, and transaction fulfillment interactions.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET/POST | `/api/shipments` | `server/src/api/shipments.rs` | Customers shipments hub | GET `shipments.view`; POST `shipments.manage` | Staff Access | POST yes | shipments | Not traced | High | Manual shipment creation. |
| GET | `/api/shipments/batch-candidates` | `shipments.rs` | Shipments hub | `shipments.view` | Staff Access | No | shipments/orders | Not traced | Medium | Batch candidate read. |
| GET | `/api/shipments/batches` | `shipments.rs` | Shipments hub | `shipments.view` | Staff Access | No | shipment batches | Not traced | Medium | Batch list. |
| POST | `/api/shipments/batches/manifest` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | Yes external/Shippo | shipment batches/manifests | Not traced | High | Creates provider manifest. |
| POST | `/api/shipments/batches/pickup` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | Yes external/Shippo | pickups/batches | Not traced | High | Schedules pickup. |
| GET/PATCH | `/api/shipments/{id}` | `shipments.rs` | Shipments hub | read/manage split | Staff Access | PATCH yes | shipments/timeline | Not traced | High | Status/tracking/address mutation. |
| POST | `/api/shipments/{id}/rates` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | External quote | shipment quotes | Shippo logic tests exist | High | Provider rate quote. |
| POST | `/api/shipments/{id}/apply-quote` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | Yes | shipment quote selection | Not traced | High | Applies selected rate. |
| POST | `/api/shipments/{id}/purchase-label` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | Yes external/Shippo | shipments/labels/transactions | Not traced | Critical | Buys label and changes fulfillment path. |
| POST | `/api/shipments/{id}/refund-label` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | Yes external/Shippo | shipment labels/refunds | Not traced | High | Label refund. |
| POST | `/api/shipments/{id}/return-shipment` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | Yes external/Shippo | return shipment rows | Not traced | High | Creates return shipment. |
| POST | `/api/shipments/{id}/notes` | `shipments.rs` | Shipments hub | `shipments.manage` | Staff Access | Yes | shipment notes/timeline | Not traced | Medium | Staff note. |
| POST | `/api/pos/shipping/rates` | `server/src/api/pos.rs` | POS shipping modal | POS session/staff | Staff/POS context | External quote only | quote/settings | Shippo logic tests exist | High | POS quote path. |
| POST | `/api/store/shipping/rates` | `server/src/api/store.rs` | Public storefront | public guest cart context | Public | External quote only | quote/session | Not traced | High | Estimate-only until paid order binds quote. |
| POST | `/api/webhooks/shippo`, `/api/integrations/shippo/webhook` | `server/src/api/webhooks.rs` | Shippo provider | Shippo webhook secret when configured | Provider auth | Yes | shipments, timeline, notifications | Webhook validation tests partially traced | Critical | Updates shipment status from provider. |

## Contract Notes

- Public store shipping rates are estimate-only until checkout binds the quote.
- Shippo webhook verification depends on configured secret; missing-secret behavior should be treated as a deployment risk.
- Shipment purchase/label/refund/return flows cross external provider state and local fulfillment state.

## Permission Notes

- Shipments use `shipments.view` for reads and `shipments.manage` for writes/provider actions.
- POS shipping rates use register context.
- Storefront shipping rates are public and must stay quote-only.

## Mutation / Side Effect Notes

- Label purchase, refund, return shipment, manifest, pickup, and webhook status updates are external side effects.
- Shipment state can affect fulfillment/pickup semantics and customer communication.

## Transaction / Idempotency Notes

- Shipment logic uses transactions in several service functions.
- Follow-up should verify idempotency for label purchase retries and duplicate Shippo webhooks.

## Audit Trail Notes

- Shipment timeline/notes should preserve actor/source and provider references.
- Follow-up should confirm label purchase/refund webhook events are visible in the customer/order timeline.

## Test Coverage

- `server/src/logic/shippo.rs` includes provider helper tests.
- v0.90.0 changelog notes Shippo health tests for disabled/missing/healthy states.
- Missing: endpoint-level `shipments.manage` tests and duplicate webhook tests.

## Risks

- Critical: label purchase and Shippo webhook updates.
- High: public/POS quote semantics, label refund, return shipment, pickup/manifest provider calls.

## Recommended Follow-Up

- Add duplicate webhook and duplicate label purchase tests.
- Add RBAC tests for `shipments.view` vs `shipments.manage`.
- Verify missing webhook secret behavior is documented in deployment checks.

