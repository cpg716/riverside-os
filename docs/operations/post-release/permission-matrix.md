# Section 5 Permission Matrix

Date: 2026-05-12

This matrix records the current post-release permission posture for sensitive workflows. It is an operational signoff aid, not a replacement for code-level authorization. Unknown items require targeted source audit before rollout reliance.

| Workflow | Visible gate / role | Step-up or manager rule | Current coverage evidence | Status | Risk | Remaining action |
| --- | --- | --- | --- | --- | --- | --- |
| Standard refund | Refund processing permission and register session context | Standard authorized staff path | QBO audit refund coverage; operational smoke refund modal | Confirmed permissioned | Critical | Keep refund queue and register evidence paired in signoff |
| Cross-day refund | Refund queue and QBO return/refund date handling | No separate step-up proven in Section 5 scope | QBO asynchronous return/refund coverage | Partial | Critical | Targeted permission test if policy requires elevated approval |
| Split-tender refund | Refund capacity and liability semantics | Provider-backed split concurrency not covered | Cash capacity/retry contract; tender/liability QBO coverage | Partial | Critical | Add provider-safe split-refund contract before live provider reliance |
| Manual / migration refund | Admin approval required | Salesperson approval denied; reason required | QBO audit contract proves salesperson denial and admin approval | Confirmed permissioned | Critical | Manual accounting signoff still required |
| Financial date correction | QBO date/edit endpoint coverage | Elevated accounting/admin rule not fully matrixed here | QBO financial date correction contract | Partial | Critical | Add permission-denied/allowed contract if not already covered elsewhere |
| QBO proposal generation | QBO permissioned endpoint | Staff actor attribution captured for proposal action | QBO audit proposal attribution and balance contract | Confirmed permissioned | Critical | Keep accounting approval separate from proposal generation |
| QBO approval/posting/sync | QBO staging UI/API permission | Accounting/admin approval workflow | QBO staging shell and approval-gate coverage | Confirmed permissioned | Critical | Manual accounting posting signoff |
| Register close with variance | Register session close and Register #1 ownership | Closing notes required over variance threshold | Register close reconciliation contract | Confirmed permissioned | Critical | Store manager close packet review |
| Inventory adjustment | Inventory permission implied by inventory APIs | Step-up not confirmed in this matrix | Inventory audit coverage for stock truth, not permission denial | Partial | High | Add inventory adjustment permission contract |
| Receiving override / stale paperwork | Procurement mutate permission | Override rule not confirmed | Receiving API/UI exact-once and concurrency contracts | Partial | Critical | Add stale-paperwork/override permission contract if workflow exists |
| Product edit affecting cost/price/stock/tax/accounting | Product/admin permissions implied by product APIs | Step-up not confirmed | Inventory value and product setup contracts use staff attribution | Partial | High | Targeted product edit permission and audit contract |
| Restocked return | Return workflow permission and register context | No separate restock step-up proven | Inventory audit and QBO restock contract coverage | Partial | Critical | Confirm restock-specific permission expectation |
| Bug report submission | Support/diagnostics UI route | No manager step-up expected | Bug reporting diagnostics redaction coverage | Confirmed permissioned for workflow access where routed | High | Manual support review of exported evidence |
| Diagnostics/support export downloads | Support Center / diagnostics routes | No manager step-up proven | Bug diagnostics export redaction coverage | Partial | High | Add route-level permission denied/allowed contract if missing |
| Dev Center access | Dev/support/admin surface | Admin/support-only expectation | Not proven in this matrix | Unknown | High | Targeted source audit and permission contract |
| ROSIE logs / degraded runtime evidence | Support/diagnostics surface | No manager step-up proven | Bug diagnostics/support failure-state coverage | Partial | High | Confirm role gate and redaction on live evidence |
| Manager override | PIN/manager authorization path | Admin is current strongest manager-equivalent for legacy refunds | Manual legacy refund contract | Confirmed for legacy refunds | Critical | Separate manager-role design remains out of scope |
| PIN escalation | Access PIN verification | Admin/staff PIN used by protected flows | QBO/refund/register tests exercise PIN-backed helpers | Partial | Critical | Add explicit PIN denial contract for high-risk workflows |
| Session isolation between staff/registers | POS session token and Register # ownership | Closed tokens denied; satellite close denied | Register audit and close contracts | Confirmed permissioned | Critical | Add close-race contract if needed |
| Sensitive action audit logging | Action-specific audit/event rows | Actor should be recorded where available | Manual legacy refund, QBO proposal, register parked-sale purge coverage | Partial | Critical | See audit trail matrix for per-action gaps |

## Signoff Rules

- UI visibility is not authorization proof.
- Admin approval is the current strongest available manager-equivalent for manual legacy refunds.
- QBO proposal generation is accounting evidence only; approval/posting remains human-controlled.
- Counterpoint imported tax evidence is not tax filing proof.
