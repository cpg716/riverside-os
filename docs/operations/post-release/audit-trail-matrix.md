# Section 5 Audit Trail Matrix

Date: 2026-05-12

This matrix records actor, reason, audit-log, and redaction evidence for sensitive post-release workflows. It only marks behavior confirmed where current docs or targeted contracts provide evidence.

| Workflow | Actor evidence | Reason / note evidence | Audit log or durable evidence | Redaction / privacy evidence | Current coverage | Status | Remaining action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Standard refund | Register/session and transaction payment evidence | Return reason captured on return lines | Payment allocation rows and QBO refund evidence | No raw card data asserted | QBO refund contract | Confirmed audited | Add route-level redaction assertion if provider payloads enter scope |
| Cross-day refund | Transaction/refund dates in QBO evidence | Return/refund dates preserved | Return-day liability and refund-day clearing lines | Not applicable in current contract | QBO async refund contract | Confirmed audited | Permission-specific audit gap remains |
| Split-tender refund | Cash refund allocation evidence for capacity/retry | Queue amount controls refund capacity | Single negative allocation after retry/over-capacity attempts | Provider evidence out of scope | QBO cash capacity/retry contract | Partial | Provider-backed split audit contract if safe simulation exists |
| Manual / migration refund | Admin staff ID captured in metadata | Manager/admin reason required and preserved | Transaction audit event `refund_processed`; payment metadata | Provider credentials not involved in manual path | Manual legacy refund contract | Confirmed audited | Manual terminal evidence remains accounting signoff item |
| Financial date correction | Staff-authenticated route in QBO contract | Change intent visible through date/edit contract | QBO proposal date remains intended | Not applicable | QBO financial date contract | Partial | Add explicit actor/reason assertion if source exposes it |
| QBO proposal generation | Proposal audit metadata includes acting staff ID | Activity date recorded | QBO stage payload includes proposal audit action/date | Contract asserts no token/secret/credential/password text in proposal audit | QBO proposal attribution contract | Confirmed audited | Accounting approval still required |
| QBO approval/posting/sync | Staff-authenticated QBO staging flow | Approval gate evidence | Pending/revision/drilldown evidence | Secrets not asserted in staging UI contract | QBO audit and staging contracts | Partial | Add dedicated approval/sync audit-log contract if needed |
| Register close with variance | Session token and register owner evidence | Notes required above variance threshold | Register close response, reconciliation, EOD/QBO pending evidence | Not applicable | Register close reconciliation contract | Confirmed audited | Manual close packet signoff |
| Inventory adjustment | Actor visible in product setup helpers only | Change note exists in some test setup | No focused adjustment audit proof in this matrix | Not applicable | Inventory audit contracts | Partial | Add adjustment audit-log contract |
| Receiving override / stale paperwork | Procurement staff headers in receiving APIs | Invoice number and receipt request evidence | Receiving event ID, PO state, product timeline event | Not applicable | Receiving API exact-once and concurrent contracts | Confirmed audited for receipt path | Override/stale paperwork audit remains unknown |
| Product edit affecting cost/price/stock/tax/accounting | Product setup helpers include changed-by staff in covered setup | Product change note in setup | Product/control-board evidence, not edit audit proof | Not applicable | Inventory/product tests | Partial | Target product edit audit contract |
| Restocked return | Register/session and transaction return evidence | Return reason captured | Return line, refund queue, QBO restock lines | Not applicable | Inventory audit and QBO restock contract | Confirmed audited | Confirm restock actor in transaction audit if needed |
| Bug report submission | Submitted report context | Staff-entered report details | Bug report record and downloadable detail | Diagnostics redaction tests cover cookies/session/provider-like secrets | Bug reporting diagnostics spec | Confirmed redacted | Manual support evidence review |
| Diagnostics/support exports | Support Center feeds and downloads | Not applicable | Downloaded diagnostics evidence | Redaction coverage for stored browser diagnostics and error events | Bug reporting diagnostics spec | Confirmed redacted | Route permission matrix remains separate |
| Dev Center access | Unknown in current Section 5 package | Unknown | Unknown | Unknown | None in current package | Unknown | Targeted Dev Center source audit |
| ROSIE logs / degraded runtime evidence | Support Center degraded feed context | Not applicable | Degraded diagnostic feed remains visible when one feed fails | Redaction inherited from diagnostics where tested | Bug reporting diagnostics spec | Partial | Confirm live ROSIE log redaction and role gate |
| Manager override | Admin staff ID captured for legacy refund | Reason required | Transaction audit event and payment metadata | Not applicable | Manual legacy refund contract | Confirmed audited for legacy refunds | Broader manager override matrix needed |
| PIN escalation | PIN-authenticated helpers exercise protected paths | Not always reason-bearing | Authorization outcome visible in contracts | PIN values are test credentials only | QBO/register/refund specs | Partial | Add explicit failed PIN audit coverage |
| Session isolation | POS session ID/token required | Closing notes where needed | Closed tokens rejected; satellite close denied | Not applicable | Register audit and close specs | Confirmed audited | Add close-race evidence if required |

## Audit Principles

- Actor attribution must distinguish operator, manager/admin approver, and accounting reviewer.
- Reason capture is required for manual legacy refund approval and variance close exceptions.
- Diagnostics exports must not expose secrets, tokens, raw card data, or provider credentials.
- Manual signoff remains required for accounting approval, live bridge proof, and store-floor evidence.
