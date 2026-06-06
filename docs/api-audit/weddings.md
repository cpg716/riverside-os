# Weddings / Group Pay API Audit

## Scope

Inspected `/api/weddings`, wedding order docs, POS wedding consumers, Wedding Manager consumers, and cross-links to checkout, deposits, open deposits, and order lifecycle.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/weddings/events` | `server/src/api/weddings.rs` | Wedding shell SSE | `weddings.view` | Staff Access | No stream | wedding event bus | Not traced | Medium | Realtime event stream. |
| GET | `/api/weddings/morning-compass` | `weddings.rs` | POS dashboard, Operations | `weddings.view` | Staff Access | No | wedding/order/customer summary | Not traced | Medium | Operational summary. |
| GET | `/api/weddings/activity-feed` | `weddings.rs` | Operations/Register | `weddings.view` | Staff Access | No | wedding activity/timeline | Not traced | Medium | Feed read. |
| GET | `/api/weddings/actions` | `weddings.rs` | Wedding manager dashboard | `weddings.view` | Staff Access | No | wedding action data | Not traced | Medium | Action queue. |
| GET | `/api/weddings/readiness-dashboard` | `weddings.rs` | Wedding readiness | `weddings.view` | Staff Access | No | wedding/transaction lines | Not traced | High | Fulfillment readiness read. |
| GET | `/api/weddings/cutover/summary` | `weddings.rs` | Counterpoint cutover | `weddings.view` | Staff Access | No | cutover/import tables | Not traced | High | Imported transaction linking context. |
| POST | `/api/weddings/cutover/links` | `weddings.rs` | Cutover review | `weddings.mutate` | Staff Access | Yes | wedding cutover link tables, transaction line refs | Not traced | Critical | Links imported financial records to wedding members. |
| POST | `/api/weddings/cutover/suggestions/{suggestion_id}/reject` | `weddings.rs` | Cutover review | `weddings.mutate` | Staff Access | Yes | cutover suggestion rows | Not traced | High | Rejects link suggestion. |
| GET/POST | `/api/weddings/non-inventory` | `weddings.rs` | Wedding checklist/settings | read/write split | Staff Access | POST yes | non-inventory wedding items | Not traced | Medium | Checklist item source. |
| PATCH/DELETE | `/api/weddings/non-inventory/{id}` | `weddings.rs` | Wedding checklist/settings | `weddings.mutate` | Staff Access | Yes | non-inventory item rows | Not traced | Medium | Checklist mutation. |
| GET/POST | `/api/weddings/appointments` | `weddings.rs` | Wedding scheduler | read/write split | Staff Access | POST yes | appointments | Not traced | High | Schedule/customer workflow. |
| GET | `/api/weddings/appointments/search` | `weddings.rs` | Wedding scheduler/search | `weddings.view` | Staff Access | No | appointments | Not traced | Medium | Search read. |
| GET/PATCH/DELETE | `/api/weddings/appointments/{appointment_id}` | `weddings.rs` | Wedding scheduler | read/write split | Staff Access | PATCH/DELETE yes | appointments | Not traced | High | Schedule mutation. |
| GET | `/api/weddings/customers/{customer_id}/purchase-context` | `weddings.rs` | POS wedding/cart context | `weddings.view` or POS session path | Staff/POS context | No | customer/wedding/transaction context | Not traced | High | Drives POS wedding prompts. |
| GET/POST | `/api/weddings/parties` | `weddings.rs` | Wedding manager, search input | GET `weddings.view`; POST `weddings.mutate` | Staff Access | POST yes | wedding parties | Wedding app smoke only traced | High | Party creation and search. |
| GET | `/api/weddings/parties/{party_id}/ledger` | `weddings.rs` | Wedding ledger | `weddings.view` | Staff Access | No | transactions/payment allocations/open deposits | Not traced | Critical | Financial group pay view. |
| GET | `/api/weddings/parties/{party_id}/financial-context` | `weddings.rs` | Wedding/POS group pay | `weddings.view` | Staff Access | No | transactions/payment allocations/open deposits | Not traced | Critical | Group payment context. |
| POST | `/api/weddings/parties/{party_id}/restore` | `weddings.rs` | Wedding admin | `weddings.mutate` | Staff Access | Yes | wedding parties | Not traced | High | Restores archived party. |
| GET | `/api/weddings/parties/{party_id}/health` | `weddings.rs` | Wedding manager | `weddings.view` | Staff Access | No | wedding health | Not traced | Medium | Health read. |
| GET | `/api/weddings/parties/{party_id}/readiness` | `weddings.rs` | Wedding readiness | `weddings.view` | Staff Access | No | transaction line lifecycle | Not traced | High | Fulfillment readiness. |
| GET | `/api/weddings/parties/{party_id}/cutover` | `weddings.rs` | Cutover review | `weddings.view` | Staff Access | No | cutover data | Not traced | High | Imported data mapping. |
| POST | `/api/weddings/parties/{party_id}/cutover/review` | `weddings.rs` | Cutover review | `weddings.mutate` | Staff Access | Yes | cutover review rows | Not traced | Critical | Approves/reviews imported state. |
| POST | `/api/weddings/parties/{party_id}/members` | `weddings.rs` | Wedding manager, customers workspace | `weddings.mutate` | Staff Access | Yes | wedding members/customer links | Not traced | Critical | Adds financial/fulfillment participant. |
| GET/PATCH/DELETE | `/api/weddings/parties/{party_id}` | `weddings.rs` | Wedding manager | read/write split | Staff Access | PATCH/DELETE yes | wedding parties | Not traced | High | Party status/date/customer data. |
| POST | `/api/weddings/attach-order` | `weddings.rs` | POS/order linking | `weddings.mutate` | Staff Access | Yes | transaction/wedding member links | Not traced | Critical | Links Transaction Record to wedding context. |
| GET/PATCH/DELETE | `/api/weddings/members/{member_id}` | `weddings.rs` | Wedding manager | read/write split | Staff Access | PATCH/DELETE yes | wedding members, measurements/notes | Not traced | Critical | Member data links to transactions/fulfillment. |

## Contract Notes

- Wedding financial anchor is `transaction_id`; logistical status flows through `transaction_lines` and related fulfillment/order lifecycle.
- Group pay disbursements are handled during checkout via `wedding_disbursements[]`.
- Open deposits are distinct from store credit and are applied later through checkout.

## Permission Notes

- Read routes use `weddings.view`.
- Mutations use `weddings.mutate`.
- POS-integrated wedding surfaces may use staff headers or valid POS session depending on the consumer path.

## Mutation / Side Effect Notes

- Cutover links, attach-order, member creation/edit, and financial-context group pay linkage are high-risk because they connect customers, wedding members, Transaction Records, and fulfillment readiness.
- Wedding group pay affects payment allocations/open deposits through checkout rather than direct wedding endpoints.

## Transaction / Idempotency Notes

- Wedding handlers contain explicit transactions in several mutation paths.
- Follow-up should verify attach-order and cutover review idempotency when repeated or partially failed.

## Audit Trail Notes

- Wedding lifecycle and cutover actions should preserve actor, timestamp, transaction/member/entity references.
- Follow-up should confirm complete audit rows for attach-order, cutover approval, member deletion, and party restore.

## Test Coverage

- `client/src/components/wedding-manager/App.test.jsx` is a smoke test only.
- Wedding readiness and lifecycle tests were not fully traced in this pass.
- Missing: endpoint-level tests for group pay linking, cutover links, attach-order, and permissions.

## Risks

- Critical: attach-order, cutover links/review, member create/edit/delete, financial context correctness, group pay checkout interaction.
- High: party create/edit/delete, readiness dashboard semantics.

## Recommended Follow-Up

- Add tests around wedding group pay disbursement and open-deposit application.
- Add endpoint RBAC tests for `weddings.view` vs `weddings.mutate`.
- Trace all wedding endpoints to exact DB tables and audit events.

