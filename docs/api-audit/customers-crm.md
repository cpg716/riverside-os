# Customers / CRM API Audit

## Scope

Inspected `/api/customers` route family at the permission-helper level, known customer hub docs, POS/customer frontend consumers, RMS Charge subflows, duplicate/merge/group/store credit paths, and customer communication side effects.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET/POST | `/api/customers` | `server/src/api/customers.rs` | Customers workspace, POS customer create | Staff or POS session for access; edit permission for writes | Staff/POS context | POST yes | `customers`, profile tables | Not fully traced | High | Customer identity source. |
| GET | `/api/customers/search`, `/browse` | `customers.rs` | POS customer selector, customer workspace | Staff or POS session | Staff/POS context | No | customers/wedding context | Not traced | Medium | PII search. |
| GET/PATCH | `/api/customers/{id}` | `customers.rs` | Customer hub/workspace | read `customers.hub_view` or POS; write `customers.hub_edit` | Staff/POS context | PATCH yes | `customers` | Not traced | High | Profile, marketing, VIP flags. |
| GET | `/api/customers/{id}/hub`, `/profile`, `/weddings` | `customers.rs` | Relationship hub drawer | `customers.hub_view` or POS session | Staff/POS context | No | customer/wedding/transaction summaries | Not traced | Medium | Rich PII and financial context. |
| GET/POST | `/api/customers/{id}/timeline`, `/notes` | `customers.rs` | Customer hub | `customers.timeline` or POS session | Staff/POS context | POST yes | timeline/note tables | Not traced | Medium | CRM note audit needed. |
| GET/PATCH | `/api/customers/{id}/measurements` | `customers.rs` | Measurement vault | `customers.measurements` | Staff Access | PATCH yes | customer measurements | Not traced | High | Sensitive body measurements. |
| GET | `/api/customers/{id}/transaction-history` | `customers.rs` | Customer hub | `orders.view` or POS session | Staff/POS context | No | transactions/payment/customer joins | Not traced | High | Financial history. |
| GET/POST | `/api/customers/{id}/store-credit`, `/store-credit/adjust` | `customers.rs`, `logic/store_credit.rs` | Customer hub | GET customer access; POST `store_credit.manage` | Staff Access | POST yes | store credit account/ledger | Not traced | Critical | Financial balance mutation. |
| GET | `/api/customers/{id}/open-deposit` | `customers.rs` | Customer hub/POS | customer access | Staff/POS context | No | open deposit account/ledger | Not traced | High | Deposit liability read. |
| POST/DELETE | `/api/customers/{id}/couple-link*` | `customers.rs` | Customer relationship hub | `customers.couple_manage` | Staff Access | Yes | customer couple/link tables | Not traced | High | Relationship identity mutation. |
| POST | `/api/customers/merge` | `customers.rs`, `logic/customer_merge.rs` | Duplicate review/customer workspace | `customers.merge` | Manager-class permission | Yes | customers, transactions, weddings, loyalty, store credit | Not traced | Critical | Re-points business history and deletes/archives duplicate. |
| GET/POST | `/api/customers/duplicate-*` | `customers.rs` | Duplicate review queue | `customers_duplicate_review` | Staff Access | POST yes | duplicate candidate/review tables | Not traced | High | Identity cleanup workflow. |
| GET/POST/DELETE | `/api/customers/groups`, `/group-members` | `customers.rs` | Customer groups UI | `customer_groups.manage` for writes | Staff Access | Writes yes | customer groups/member tables | Not traced | Medium | Segmentation/grouping. |
| POST | `/api/customers/import/lightspeed` | `customers.rs`, `logic/lightspeed_customers.rs` | Customers workspace import | customer edit/import permission | Staff Access | Yes | customers/import issue data | Logic tests exist | High | External customer import. |
| POST | `/api/customers/bulk-vip` | `customers.rs` | Customer workspace | `customers.hub_edit` | Staff Access | Yes | customers VIP flags | Not traced | Medium | Bulk CRM mutation. |
| GET/POST | `/api/customers/podium/*`, `/api/customers/{id}/podium/*` | `customers.rs` | Podium inbox/hub | customer timeline/edit permissions | Staff/POS context for selected sends | Sends yes | Podium message/conversation/notification tables | Not traced | High | External customer communications. |
| GET/POST/PATCH | `/api/customers/rms-charge/*` | `customers.rs`, `pos.rs` | RMS Charge admin/POS | `customers.rms_charge.*`, `pos.rms_charge.*` | Staff/POS context | Writes yes | RMS charge accounts/records/reconciliation | Not traced | Critical | Internal financing/payment ledger. |
| GET/POST | `/api/customers/address-*` | `customers.rs` | Address autocomplete/validation | customer access | Staff/POS context | Validation external | none or address metadata | Not traced | Medium | Should fail soft without blocking customer save. |

## Contract Notes

- Customer access often allows either Back Office staff with the proper permission or a valid open POS session.
- Merge must preserve transaction, wedding, loyalty, store credit, and communication history.
- RMS Charge has split permissions for view, link management, exception resolution, reconciliation, reversal, reporting, and POS tender use.

## Permission Notes

- Customer hub read/write is split across `customers.hub_view` and `customers.hub_edit`.
- Timeline, measurements, merge, groups, store credit, duplicate review, RMS Charge, and couple management use dedicated keys.
- POS session fallback is appropriate for cashier workflows but must not grant Back Office-only mutations.

## Mutation / Side Effect Notes

- Customer merge, store credit adjustment, RMS Charge reversals, Podium outbound messages, profile edits, and Lightspeed/Counterpoint imports are high-risk side effects.
- Communication endpoints have external sends and customer opt-in/privacy implications.

## Transaction / Idempotency Notes

- Customer merge and store credit logic use service-layer transaction patterns.
- Follow-up should verify idempotency for duplicate merge, import replay, Podium direct-sms retry, and RMS reconciliation actions.
- Remediation added `migrations/068_transaction_lines_discount_amount.sql` so Customer Hub lifetime-sales queries no longer fail against schemas missing `transaction_lines.discount_amount`.

## Audit Trail Notes

- Store credit and RMS Charge actions should retain staff/action/reason.
- Timeline notes preserve customer/entity context but actor attribution should be confirmed for POS-session callers.

## Test Coverage

- Customer endpoint tests were not fully traced in this pass.
- ROSIE Customer Hub snapshot coverage now passes in the full server suite, proving the Customer Hub read path works with current schema expectations.
- Customer import logic has some coverage.
- Missing: customer merge endpoint tests, store credit adjustment RBAC/audit tests, RMS Charge mutation tests, Podium send opt-in tests.

## Risks

- Critical: customer merge, store credit adjust, RMS Charge reverse/reconcile/link, customer identity import.
- High: measurements, communication sends, duplicate queue, POS-session fallback boundaries.

## Recommended Follow-Up

- Add customer API RBAC tests for staff vs POS session access.
- Add merge dry-run/apply tests covering transactions, weddings, loyalty, store credit, and communication history.
- Add opt-in and audit tests for Podium/SMS/email sends.
