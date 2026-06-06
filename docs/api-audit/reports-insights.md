# Reports / Insights / Metabase API Audit

## Scope

Inspected `/api/insights`, Metabase proxy/launch references, reporting docs, frontend consumers in Operations, Reports, Staff commissions, POS register reports, and QBO/reporting date semantics.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET/POST | `/api/insights/metabase-launch` | `server/src/api/insights.rs` | Insights shell | `insights.view` / shared auth path | Staff Access | POST may create session/launch state | Metabase integration/settings | Not traced | High | Launches analytics session. |
| GET | `/api/insights/metabase-health` | `insights.rs` | Insights/settings | `insights.view` | Staff Access | No external health | Metabase config | Not traced | Medium | Health read. |
| GET | `/api/insights/wedding-health` | `insights.rs` | Reports/operations | `insights.view` | Staff Access | No | reporting/wedding views | Tests exist around insights perms | Medium | Wedding operational report. |
| GET/POST/DELETE | `/api/insights/wedding-saved-views` | `insights.rs` | Reports | `insights.view` | Staff Access | POST/DELETE yes | saved view table | Not traced | Medium | Staff-scoped saved reporting config. |
| GET | `/api/insights/sales-pivot` | `insights.rs` | Operations, reports catalog | `insights.view` | Staff Access | No | reporting views/transactions | Insights tests exist | High | Booked vs fulfilled basis sensitive. |
| GET | `/api/insights/margin-pivot` | `insights.rs` | Reports | Admin/manager margin gate | Manager/Admin | No | cost/reporting views | Not traced | Critical | Cost/margin visibility. |
| GET | `/api/insights/commission-ledger` | `insights.rs` | Staff commission panels | `insights.view` | Staff Access | No | commission/reporting views | Not traced | High | Commission payout evidence. |
| POST | `/api/insights/commission-adjustments` | `insights.rs` | Commission manager | `staff.manage_commission` | Manager/Admin | Yes | commission adjustment tables | Not traced | Critical | Compensation mutation. |
| GET | `/api/insights/commission-lines`, `/commission-trace/{line_id}` | `insights.rs` | Commission trace modal | `insights.view`/commission permission | Staff Access | No | commission line/reporting tables | Not traced | High | Compensation detail. |
| GET | `/api/insights/rms-charges` | `insights.rs` | RMS reports | `insights.view` or RMS reporting | Staff Access | No | RMS/payment records | Not traced | High | Internal financing reporting. |
| GET | `/api/insights/register-day-activity` | `insights.rs` | Operations, POS reports | `register.reports` or `insights.view` | Staff Access | No | register sessions/payments/transactions | Not traced | Critical | Daily financial report source. |
| GET | `/api/insights/register-sessions` | `insights.rs` | Reports/operations | `register.reports` | Staff Access | No | register sessions | Not traced | High | Z/session history. |
| GET | `/api/insights/register-override-mix` | `insights.rs` | Reports | `register.reports`/insights | Staff Access | No | override/audit/payment data | Not traced | High | Manager override visibility. |
| GET | `/api/insights/nys-tax-audit` | `insights.rs` | Reports | `insights.view` | Staff Access | No | tax/reporting views | Not traced | Critical | Tax filing data. |
| GET | `/api/insights/staff-performance` | `insights.rs` | Reports | `insights.view` | Staff Access | No | reporting/staff views | Not traced | High | Staff performance data. |
| GET | `/api/insights/appointments-no-show` | `insights.rs` | Reports | `insights.view` | Staff Access | No | appointments/customers | Not traced | Medium | Operational reporting. |
| GET | `/api/insights/wedding-event-readiness` | `insights.rs` | Reports | `insights.view` | Staff Access | No | wedding readiness views | Not traced | High | Event readiness report. |
| GET | `/api/insights/staff-schedule-coverage-sales` | `insights.rs` | Reports | `insights.view` | Staff Access | No | schedule/sales reporting | Not traced | Medium | Planning report. |
| GET | `/api/insights/customer-follow-up` | `insights.rs` | Reports | `insights.view` | Staff Access | No | customers/transactions | Not traced | Medium | CRM follow-up data. |
| GET | `/api/insights/negative-stock` | `insights.rs` | Reports/ops | `insights.view` | Staff Access | No | negative stock alerts/inventory | Not traced | Critical | Inventory exception report. |
| GET | `/api/insights/exception-risk` | `insights.rs` | Reports/ops | `insights.view` | Staff Access | No | exception/audit tables | Not traced | High | Risk report. |
| GET | `/api/insights/sales-by-day`, `/sales-trend-pace` | `insights.rs` | Reports | `insights.view` | Staff Access | No | reporting views | Not traced | High | Sales trend semantics. |

## Contract Notes

- Reporting must distinguish booked/sale basis from fulfilled/recognition basis.
- Margin/cost reports require stronger access than ordinary sales reads.
- Metabase is the primary exploration surface; Axum insights endpoints are operational reads, not a parallel analytics platform.

## Permission Notes

- Most routes require `insights.view`.
- Register/day close reports may require `register.reports`.
- Margin analytics and commission adjustments use stricter gates.

## Mutation / Side Effect Notes

- Most insights endpoints are read-only.
- Commission adjustments and saved views mutate state.
- Metabase launch may create external/session side effects.

## Transaction / Idempotency Notes

- Reads generally do not need DB transactions.
- Commission adjustment write path should be verified for transactional audit and idempotency.

## Audit Trail Notes

- Reporting itself is mostly read-only, but high-sensitivity reads may need access logging.
- Commission adjustment audit should include actor, reason, amount, affected staff/line, timestamp.
- Remediation added `transaction_lines.discount_amount` as an idempotent migration repair because report and Customer Hub queries calculate net sales from line-level discounts.

## Test Coverage

- `server/src/api/insights.rs` includes tests for selected reporting permissions and ROSIE reporting permission preservation.
- `cargo test -p riverside-server` passes the ROSIE reporting permission and allowlist tests in the full server suite.
- Missing: endpoint-level coverage for all report routes, margin access, commission adjustment audit, and date-basis contract.

## Risks

- Critical: tax audit data, register day activity, commission adjustments, margin/cost visibility, negative stock report correctness.
- High: sales basis/date semantics, Metabase launch authentication, RMS charge reports.

## Recommended Follow-Up

- Add contract tests for booked vs fulfilled basis on sales and tax reports.
- Add permission tests for margin, register reports, and commission adjustment.
- Confirm reporting views use explicit rounding/casting for money aggregates.
