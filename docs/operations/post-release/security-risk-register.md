# Section 5 Security Risk Register

Date: 2026-05-12

This register tracks post-release security, permission, attribution, and redaction risks for sensitive workflows.

| Risk ID | Area | Description | Severity | Status | Evidence / current coverage | Remaining action | Owner / signoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | Manual legacy refunds | Salesperson-level approval could authorize sensitive migration refunds. | Critical | Mitigated | Contract rejects salesperson approval, requires admin approval, preserves reason and audit evidence. | Keep admin-only rule until a separate manager role design exists. | Engineering + Store manager |
| SEC-002 | Refund concurrency | Simultaneous refund requests could double-refund or double-clear liability. | Critical | Mitigated for cash refund queue path | Contract proves one cash refund allocation and no over-refund for simultaneous requests. | Extend to provider-backed split refunds only with safe provider simulation. | Engineering + Accounting |
| SEC-003 | Split refund capacity | Retry or over-capacity attempts could exceed refund due. | Critical | Partially mitigated | Cash capacity/retry contract rejects over-capacity and post-closed retry attempts. | Provider capacity/retry remains out of scope. | Engineering + Accounting |
| SEC-004 | Register lane race | Simultaneous primary register opens could create duplicate active till groups or produce unsafe errors. | Critical | Partially mitigated | Contract proves one active till group; unique race maps to `register_lane_in_use`. | Close-race contract or source audit remains. | Engineering + Store manager |
| SEC-005 | Receiving concurrency | Simultaneous same-PO receiving could double-post stock or receipt evidence. | Critical | Mitigated for same-PO single-line path | Receiving API contract proves exact-once stock and receipt timeline evidence. | Extend to multi-line/partial receipt concurrency if operationally needed. | Engineering + Inventory lead |
| SEC-006 | QBO proposal attribution | Proposal generation could lack durable actor/date evidence. | Critical | Mitigated | QBO contract proves proposal audit action, activity date, acting staff, balance, and secret redaction pattern. | Accounting approval/posting signoff still required. | Engineering + Accounting |
| SEC-007 | QBO approval/posting audit | Approval/sync actions need clear staff attribution and recovery evidence. | Critical | Partially mitigated | QBO staging/audit contracts cover approval gate and proposal revisions. | Add dedicated approval/sync audit-log contract if required. | Accounting |
| SEC-008 | Diagnostics export leakage | Bug reports or support exports could expose cookies, session IDs, provider IDs, or runtime evidence. | High | Mitigated for covered diagnostics | Bug reporting diagnostics tests cover redaction and degraded support feeds. | Confirm live support/export route permission gates. | Support lead |
| SEC-009 | Dev Center access | Dev Center access and guarded actions were not packaged with confirmed role evidence. | High | Open | No Section 5 contract evidence in this package. | Targeted Dev Center permission/source audit. | Engineering |
| SEC-010 | Inventory adjustment authorization | Inventory adjustments can affect stock truth and audit evidence. | High | Open | Inventory audit covers stock truth, not adjustment permission denial/approval. | Add inventory adjustment permission and audit contract. | Inventory lead |
| SEC-011 | Product edit authorization | Product edits can affect price, cost, taxable/accounting behavior, and stock context. | High | Open | Product setup tests include changed-by metadata, not full edit authorization proof. | Targeted product edit permission/audit contract. | Store manager + Accounting |
| SEC-012 | Financial date correction | Date corrections can shift accounting/reporting periods. | Critical | Partially mitigated | QBO date/edit contract preserves intended QBO day. | Add explicit permission-denied/allowed and reason/audit assertions. | Accounting |
| SEC-013 | Restocked return permission | Restock marking changes stock and QBO inventory/COGS evidence. | Critical | Partially mitigated | Restock inventory and QBO accounting contracts exist. | Confirm restock-specific permission and actor audit if required. | Inventory lead + Accounting |
| SEC-014 | Session isolation | Stale or cross-register tokens could affect register truth. | Critical | Partially mitigated | Closed tokens rejected; satellite close denied; linked lane ownership covered. | Add close-race contract if needed. | Store manager |
| SEC-015 | Live Counterpoint proof trust | Counterpoint proof/status UI coverage uses mocked/local evidence, not live bridge proof. | High | Manual-only | Section 4 docs mark live bridge latency/proof as unmeasured; reporting docs warn imported tax is not filing proof. | Manual bridge proof signoff and targeted live payload baseline. | Accounting/import owner |

## Risk Handling Rules

- Do not weaken permission gates to make operational flows easier.
- Do not treat UI visibility as authorization.
- Do not expose secrets, tokens, raw card data, or provider credentials in diagnostics.
- Do not treat QBO proposal generation as approval/posting.
- Do not treat Counterpoint imported tax as filing proof.
