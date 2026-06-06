# ROSIE AI API Audit

## Scope

Inspected `/api/help/rosie/v1/*`, `/api/ai/visual/*`, ROSIE help docs, permission preservation tests, and current retired-route guidance.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/help/search` | `server/src/api/help.rs` | Help drawer, ROSIE retrieval | authenticated help viewer or POS fallback | Staff/POS context | No | help index/docs | Help tests exist | Medium | Search source for ROSIE context. |
| GET | `/api/help/manuals`, `/manuals/{manual_id}` | `help.rs` | Help drawer | authenticated help viewer or POS fallback | Staff/POS context | No | help manual manifest/policies | Help tests exist | Low | Help content read. |
| POST | `/api/help/rosie/v1/tool-context` | `help.rs` | ROSIE drawer | authenticated staff/POS, underlying permissions preserved | Staff/POS context | No business write | reads allowed tool contexts | Permission tests exist | High | Must preserve operational permission gates. |
| POST | `/api/help/rosie/v1/chat/completions` | `help.rs` | ROSIE chat | authenticated staff/POS | Staff/POS context | External/local LLM call | token telemetry maybe | Not fully traced | High | Local/upstream LLM route; output must be staff-reviewed. |
| POST | `/api/help/rosie/v1/insight-summary` | `help.rs` | ROSIE insight cards | authenticated staff/POS, underlying report permissions | Staff/POS context | No business write | reporting reads/token telemetry | Permission tests exist | High | Must not bypass report permissions. |
| POST | `/api/help/rosie/v1/search-intent` | `help.rs` | ROSIE search assistance | authenticated staff/POS | Staff/POS context | No business write | search/read only | Not traced | Medium | Classification/drafting. |
| GET | `/api/help/rosie/v1/runtime-status` | `help.rs` | ROSIE settings/help | authenticated staff/POS | Staff/POS context | No | runtime config/status | Not traced | Medium | Runtime diagnostic. |
| POST | `/api/help/rosie/v1/voice/transcribe` | `help.rs` | ROSIE voice | authenticated staff/POS | Staff/POS context | External/local STT | temp audio/runtime | Not traced | Medium | Speech path. |
| POST | `/api/help/rosie/v1/voice/synthesize`, `/speak`, `/stop` | `help.rs` | ROSIE voice | authenticated staff/POS | Staff/POS context | Host TTS/playback state | runtime state | Not traced | Medium | Local host side effect, not business data mutation. |
| GET | `/api/help/rosie/v1/voice/status` | `help.rs` | ROSIE voice | authenticated staff/POS | Staff/POS context | No | runtime state | Not traced | Low | Playback status. |
| GET/POST | `/api/help/rosie/v1/intelligence/status`, `/refresh` | `help.rs` | ROSIE settings/help | authenticated staff/POS; admin may be required by handler | Staff/POS context | Refresh yes | intelligence cache/index | Logic tests exist | Medium | Cache/index refresh, no business write expected. |
| GET | `/api/help/rosie/v1/capabilities` | `help.rs` | ROSIE UI | authenticated staff | Staff Access | No | capabilities/config | Regression test added | Low | Fixed: handler now matches intended any-authenticated-staff access. |
| POST | `/api/help/rosie/v1/product-catalog-analyze`, `/product-catalog-suggest` | `help.rs` | Product intelligence | catalog permission preserved | Staff Access | Suggestion/write? analyze mostly read | products/catalog audit | Help tests exist | High | Must not mutate catalog without explicit staff confirmation. |
| POST | `/api/help/rosie/v1/e2e/*` | `help.rs`, `e2e_gateway.rs` | ROSIE E2E tools | help/admin gate expected | Manager/Admin | Generates/runs test artifacts | test/manual artifacts | Not traced | Medium | Should stay non-production mutation only. |
| GET/PUT/DELETE | `/api/help/admin/manuals*` | `help.rs` | Help settings | `help.manage` | Manager/Admin | Writes yes | help manual policy/content | Help tests exist | Medium | Help policy/content mutation. |
| POST/GET | `/api/help/admin/ops/*` | `help.rs` | Help settings | `help.manage` | Manager/Admin | Ops writes yes | manifest/index/screenshot artifacts | Help tests exist | Medium | Help maintenance. |
| POST | `/api/ai/visual/dispatch` | `server/src/api/ai.rs` | Store/product visual generation | authenticated staff | Staff Access | Yes visual job | visual job tables/assets | Not traced | Medium | Fal.ai visual sidecar only; not legacy business AI. |
| GET | `/api/ai/visual/status/{job_id}`, `/visual/jobs`, `/fal-health` | `ai.rs` | Visual generation UI/settings | authenticated staff | Staff Access | No | visual jobs/config | Not traced | Low | Visual job reads/health. |

## Contract Notes

- Retired legacy `/api/ai/help`, `/api/ai/admin/reindex-docs`, and old AI tables must not be revived.
- ROSIE must not directly mutate financial, payment, accounting, or inventory state without human review and existing service-layer permissions.
- ROSIE tool context should use whitelisted read tools and preserve underlying endpoint permissions.

## Permission Notes

- Help/ROSIE viewer paths support authenticated staff and POS fallback in selected handlers.
- Admin Help Center operations require `help.manage`.
- ROSIE reporting and product catalog tools have tests asserting underlying permissions are preserved.
- `rosie_capabilities` now matches the intended access contract: any authenticated staff member may read capability metadata.

## Mutation / Side Effect Notes

- ROSIE chat/voice mostly has runtime/telemetry side effects, not business writes.
- Product catalog suggestion/analyze must remain recommendation-only unless a separate confirmed catalog mutation endpoint is used.
- Visual generation writes visual job records/assets.

## Transaction / Idempotency Notes

- Most ROSIE routes are request/response reads or runtime calls.
- Intelligence refresh and visual dispatch should be checked for duplicate-job/idempotency behavior.

## Audit Trail Notes

- Token telemetry is recorded non-blockingly in ROSIE intelligence paths.
- Product catalog audit tests exist for ROSIE catalog audit behavior.
- Follow-up should verify staff id and source prompt/action metadata on visual jobs and catalog suggestions.

## Test Coverage

- `server/src/api/help.rs` includes permission-preservation tests for ROSIE operational context and product catalog analysis.
- `server/src/api/help.rs` includes a regression test proving authenticated staff without `help.manage` can read ROSIE capabilities.
- `cargo test -p riverside-server rosie_tool_context_` passes the current ROSIE tool-context matrix for orders, customers, weddings, inventory cost protection, unsupported-tool withholding, and permission denial.
- `server/src/logic/rosie_intelligence.rs` includes telemetry/intelligence contract tests.
- Missing: endpoint tests for visual dispatch RBAC and any future tool-context domains added after this audit.

## Risks

- High: tool-context or reporting permission bypass, product catalog suggestions becoming silent writes, chat output treated as authoritative.
- Medium: voice/runtime side effects, visual job asset writes, help admin ops.

## Recommended Follow-Up

- Keep the ROSIE tool permission matrix current when new operational tool domains are added.
- Add explicit tests that ROSIE cannot write financial/payment/accounting/inventory state.
