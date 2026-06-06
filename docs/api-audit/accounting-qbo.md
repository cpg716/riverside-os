# Accounting / QBO API Audit

## Scope

Inspected `/api/qbo`, `/api/auth/qbo`, QBO staging routes, explicit mapping gates, account-cache refresh, webhook logging, and frontend consumers in QBO settings, QBO workspace, and operations dashboards.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/qbo/integration` | `server/src/api/qbo.rs` | QBO settings/workspace | `qbo.view` | Staff Access | No | `qbo_integration` | Not traced | Medium | Connection status. |
| GET | `/api/qbo/company-info` | `qbo.rs` | QuickBooks settings | `qbo.view` | Staff Access | External read/token refresh possible | `qbo_integration`, encrypted credentials | Not traced | High | Calls Intuit CompanyInfo. |
| GET | `/api/qbo/health` | `qbo.rs` | Settings/operations | `qbo.view` | Staff Access | External read/token refresh possible | `qbo_integration` | Not traced | High | Health check may refresh token. |
| GET | `/api/qbo/token-health` | `qbo.rs` | QuickBooks settings | `qbo.view` | Staff Access | No | `qbo_integration` | Not traced | Medium | Token state only. |
| GET/PUT | `/api/qbo/credentials` | `qbo.rs` | QuickBooks settings | GET `qbo.view`; PUT `qbo.mapping_edit` | Staff Access | PUT yes | `integration_credentials`, `qbo_integration` | Credential env tests exist | Critical | Stores encrypted client credentials and Realm ID. |
| POST | `/api/qbo/tokens/refresh` | `qbo.rs` | QuickBooks settings | `qbo.mapping_edit` | Staff Access | Yes external/token | encrypted credentials, `qbo_integration` | Not traced | High | Refreshes OAuth token. |
| GET | `/api/qbo/accounts-cache` | `qbo.rs` | QBO mapping UI | `qbo.view` | Staff Access | No | `qbo_accounts_cache` | Not traced | Medium | Mapping source list. |
| POST | `/api/qbo/accounts-cache/refresh` | `qbo.rs` | QBO mapping UI | `qbo.mapping_edit` | Staff Access | Yes external/cache | `qbo_accounts_cache`, `qbo_integration` | Not traced | High | Replaces active account cache in a transaction. |
| GET | `/api/qbo/mapping-categories` | `qbo.rs` | QBO mapping UI | `qbo.view` | Staff Access | No | `categories` | Not traced | Medium | Category mapping source. |
| GET/POST/DELETE | `/api/qbo/mappings` | `qbo.rs` | QBO mapping UI | GET `qbo.view`; write `qbo.mapping_edit` | Staff Access | Write yes | `ledger_mappings`, access log | Not traced | Critical | Explicit account mapping source for journals. |
| GET/POST/DELETE | `/api/qbo/granular-mappings` | `qbo.rs` | QBO mapping UI | GET `qbo.view`; write `qbo.mapping_edit` | Staff Access | Write yes | `qbo_mappings`, access log | Not traced | Critical | Validates account IDs against active cache. |
| GET | `/api/qbo/staging` | `qbo.rs` | QBO workspace, operations | `qbo.view` | Staff Access | No | `qbo_sync_logs` | Not traced | High | Shows staged journal payloads. |
| POST | `/api/qbo/staging/propose` | `qbo.rs`, `logic/qbo_journal.rs` | QBO workspace | `qbo.mapping_edit` | Staff Access | Yes | `qbo_sync_logs`, access log | QBO journal tests exist | Critical | Generates pending daily journal. |
| GET | `/api/qbo/staging/{id}/drilldown` | `qbo.rs` | QBO workspace | `qbo.view` | Staff Access | No | `qbo_sync_logs`, transactions/payments | Not traced | High | Explains journal contributors. |
| POST | `/api/qbo/staging/{id}/approve` | `qbo.rs` | QBO workspace | `qbo.staging_approve` | Manager-class permission | Yes | `qbo_sync_logs`, access log | Balanced-payload tests exist | Critical | Validates balanced payload and active accounts before approval. |
| POST | `/api/qbo/staging/{id}/revert` | `qbo.rs` | QBO workspace | `qbo.staging_approve` | Manager-class permission | Yes | `qbo_sync_logs`, access log | Not traced | Critical | Reopens approved entry. |
| POST | `/api/qbo/staging/{id}/retry` | `qbo.rs` | QBO workspace | `qbo.sync` | Staff Access | Yes external/QBO | `qbo_sync_logs`, access log | Not traced | Critical | Retries failed external sync. |
| POST | `/api/qbo/staging/{id}/sync` | `qbo.rs` | QBO workspace | `qbo.sync` | Staff Access | Yes external/QBO | `qbo_sync_logs`, credentials, Intuit JE | Not traced | Critical | Posts JournalEntry to QBO. |
| POST | `/api/qbo/staging/{id}/void` | `qbo.rs` | QBO workspace | `qbo.sync` | Staff Access | Yes external/QBO | `qbo_sync_logs`, Intuit JE | Not traced | Critical | Voids/deletes synced QBO JournalEntry. |
| GET | `/api/auth/qbo/callback` | `qbo.rs` | OAuth callback | OAuth code plus existing integration row | Provider/user OAuth | Yes | encrypted credentials, `qbo_integration` | Not traced | Critical | No staff header; relies on OAuth flow and preconfigured client credentials. |
| POST | `/api/auth/qbo/webhook` | `qbo.rs` | Intuit webhook | Provider webhook | Provider auth path not fully traced | Yes | `qbo_webhook_events` | Not traced | High | Logs Intuit account-change events. |

## Contract Notes

- QBO staging payloads carry journal lines, account IDs, account names, line detail, and totals.
- Approval validates the staged journal is balanced and accounts are active.
- Mappings are explicit; fallback mappings were removed in v0.90.0.
- Date semantics depend on activity date, booked vs fulfilled recognition, and effective store timezone.

## Permission Notes

- Read-oriented routes require `qbo.view`.
- Mapping and account-cache mutation routes require `qbo.mapping_edit`.
- Approval/revert requires `qbo.staging_approve`.
- Sync, retry, and void require `qbo.sync`.
- OAuth callback and webhook are under `/api/auth/qbo` and are not staff-header-gated in the same way as Back Office routes.

## Mutation / Side Effect Notes

- Account cache refresh performs external Intuit reads and transactional cache replacement.
- Staging propose writes pending journal payloads.
- Sync/retry/void perform external QBO JournalEntry writes/deletes and update local sync state.
- Mapping changes directly alter accounting output.

## Transaction / Idempotency Notes

- Account cache refresh uses a transaction to deactivate/replace account rows.
- Staging approval uses status predicates to avoid approving changed rows.
- Follow-up should verify sync/retry/void idempotency against repeated operator clicks and Intuit retries.

## Audit Trail Notes

- Mapping save/delete, staging propose/approve/revert/sync/void paths use `log_staff_access` in key handlers.
- QBO webhook events are persisted.

## Test Coverage

- `server/src/api/qbo.rs` includes balanced staging payload tests and credential key tests.
- `server/src/logic/qbo_journal.rs` includes journal generation tests.
- `cargo test -p riverside-server` compiles and runs the QBO background worker module in the full server suite.
- Missing: endpoint-level permission tests, OAuth callback state/CSRF validation tests, sync/retry/void duplicate-click tests.

## Risks

- Critical: mappings, staging approval, sync, retry, void, OAuth credential storage.
- High: token refresh, account cache refresh, webhook logging/auth verification, staging drilldown date semantics.

## Recommended Follow-Up

- Add endpoint authorization tests for each `qbo.*` permission boundary.
- Add duplicate-click/idempotency tests for approve, sync, retry, revert, and void.
- Verify OAuth callback state handling and webhook signature verification expectations.
- Expand QBO drilldown tests for deposit release, refunds, COGS freight, sales tax, and booked vs fulfilled dates.
