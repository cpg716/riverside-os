# API Audit Follow-Up Work

## Highest Priority Prompts

1. Audit and test POS checkout idempotency end to end.
   - Scope: `POST /api/transactions/checkout`, Helcim attempts/webhooks, payment allocations, register session token, QBO outbox.
   - Output: failing/passing tests for duplicate checkout submit, duplicate webhook, terminal failure recovery, and stale/closed session.

2. Audit and test refund, void, return, and exchange settlement authorization.
   - Scope: `/api/transactions/{id}/refunds/process`, `/void`, `/returns`, `/exchange-settlement`, `/exchange-link`.
   - Output: endpoint tests for permission gates, manager approval after 60 days, idempotency, and audit rows.

3. Audit register close and cash drawer reconciliation.
   - Scope: `/api/sessions/{id}/begin-reconcile`, `/close`, `/adjustments`, `/drawer-opens`, `/helcim-close-review/{attempt_id}`.
   - Output: transaction boundary map, tables touched, close retry behavior, and audit assertions.

4. Audit QBO staging and sync lifecycle.
   - Scope: mapping save/delete, granular mappings, propose, approve, revert, retry, sync, void, OAuth callback, webhook.
   - Output: duplicate-click tests, explicit mapping failure tests, and booked/fulfilled date contract tests.

5. Audit inventory mutation idempotency.
   - Scope: stock-adjust, variant pricing, product model cascade, PO receive, direct invoice, physical inventory publish.
   - Output: duplicate submit tests, staff attribution matrix, and stock/cost table map.

6. Audit staff RBAC and PIN mutation endpoints.
   - Scope: effective permissions, role changes, apply-role-defaults, permission edits, set-pin, verify-pin manager approvals.
   - Output: central endpoint permission matrix and audit-log assertions.

7. Audit ROSIE tool permission preservation.
   - Scope: `/api/help/rosie/v1/tool-context`, insight summary, product catalog analyze/suggest, E2E routes.
   - Output: tests proving ROSIE cannot read or mutate beyond underlying staff permissions.

8. Audit Counterpoint bridge import replay behavior.
   - Scope: `/api/sync/counterpoint/*`, `/api/settings/counterpoint-sync/*`, bridge GUI callers, staging apply/reset.
   - Output: natural-key matrix, replay tests, settings-admin RBAC tests, and provenance/audit table map.

## Documentation Gaps To Fill

- Exact request/response DTO fields for every high-risk endpoint.
- Exact database tables touched per mutation endpoint.
- Endpoint-level test names and gaps after a full `rg` of test modules and Playwright specs.
- Full frontend consumer list grouped by component for each route.
- Audit trail evidence matrix with actor, action, timestamp, entity id, before/after, reason, and external provider reference.
- Public storefront checkout/payment API audit as a separate high-risk pass.
- Full Counterpoint sync table map and replay proof beyond the initial route-level pass.
- Deployment/DevOps route audit for `/api/ops`, `/api/settings`, and support tools.

## Validation Recommendations

- Start with targeted Rust tests for the changed/high-risk module.
- Add endpoint authorization tests before broad E2E.
- Use Playwright only after endpoint tests cover the permission and idempotency contracts.
- Do not use broad refactors while closing audit findings.
