# GO-LIVE Performance and Connectivity Review - 2026

Status: CAUTION until production-sized data and real device/network smoke tests are complete.

Release evidence update: the reviewed fixes were included in the `v0.90.0` same-version rebuild published from build `6064e91c` on 2026-07-01. Local full Playwright passed on the release commit (`373 passed`, `11 skipped`), and GitHub Lint Checks, Playwright E2E, macOS ROS Dev Center Release, and Windows deployment package workflows passed on the released commit.

## Scope Reviewed

- Register startup, session hydration, checkout replay, close/Z-report blocking.
- Back Office sign-in, server URL selection, LAN and Tailscale startup access.
- Wedding Manager data loading and live refresh.
- Inventory, customer, order, receiving, and Insights access paths.
- Tauri desktop API base behavior, local server start behavior, and print/server bridge boundaries.
- PWA/same-origin API behavior and Tailscale remote access documentation.

## Critical Startup and Data-Loading Paths

| Workflow | Client path | API path | Current behavior |
|---|---|---|---|
| Back Office startup | `BackofficeSignInGate` | `/api/version`, `/api/staff/list-for-pos`, `/api/staff/effective-permissions` | Staff gate loads server version and roster before PIN sign-in. Runtime URL override supports LAN and Tailscale addresses. |
| Register startup | `RegisterSessionBootstrap`, `RegisterPickModal`, POS shell | `/api/sessions/current`, `/api/sessions/list-open`, `/api/sessions/open`, `/api/sessions/{id}/attach` | Session hydration has bounded fetches and preserves an open Register through transient Main Hub errors. |
| POS item search | POS cart/search components | Product/inventory search endpoints, Meilisearch-backed helpers where configured | Search is server-backed; no client full-catalog startup load was found in the critical POS startup path reviewed. |
| Customer search | global search drawers, customer workspace, wedding APIs | `/api/customers/search`, `/api/customers/browse`, customer hub endpoints | Search is server-backed and paginated/bounded by query params in reviewed paths. |
| Order lookup | POS exchange/order detail paths, orders workspace logic | transaction/order detail and Meilisearch order search helpers | Detail lookup is server-backed; large-order performance depends on existing order/read-path indexes and Meilisearch health. |
| Checkout | POS checkout hook, offline queue | `/api/transactions/checkout` | Online checkout requires the Main Hub. Offline checkout queues completed payloads and replays with idempotency; 4xx replay failures block for manager recovery. |
| Register close | `CloseRegisterModal`, register reports | session close and register-day activity endpoints | Ordinary authorized close remains available while recovery, card, and linked-workstation warnings stay visible and fixable. Close does not resolve or dismiss them; the immediate and archived Z-Report freeze the exact pre-close warnings under **Unresolved Issues at Close**. Cash count, check review, Daily Cash Deposit date, and an over-$5 discrepancy note remain required inputs. |
| Inventory lookup | inventory workspace, receiving bay, physical inventory | product, variant, category, vendor, PO, receiving endpoints | Lookup and receiving are API-backed. Receiving is not safe to complete offline and must surface server errors. |
| Wedding Manager startup | wedding-manager API wrapper and dashboard | `/api/weddings/*`, `/api/weddings/events` | Uses shared `getBaseUrl()` and authenticated fetch-stream SSE for live refresh; aligns with LAN/Tailscale URL selection. |
| Reports/Insights access | Insights shell, Register Reports | `/api/insights/*`, register activity/session endpoints | Reporting is API-backed and depends on indexed transaction/payment/register read paths. |

## Risks Found

| Risk | Severity | Evidence | Fix |
|---|---:|---|---|
| Sign-in gate startup requests could hang on an unreachable LAN/Tailscale host. | High | `BackofficeSignInGate` used unbounded `fetch` for version, staff roster, and effective-permission requests. | Added bounded fetches and clear Main Hub recovery messaging. |
| Offline checkout replay did not clear its abort timer when fetch threw or aborted. | Medium | `flushCheckoutQueue` cleared the timer only after `fetch` resolved. | Moved replay timeout cleanup into `finally` and named the timeout constant. |
| Legacy API helper was pinned to `http://localhost:5173/api`. | Medium | `client/src/lib/api.ts` bypassed the shared runtime API base resolver. | Switched it to `getBaseUrl()` so Tauri/PWA/Tailscale use the selected Main Hub. |
| Connection banner recovery was not explicitly covered by mocked UI tests. | Medium | Existing spec covered banner display and Register preservation during outage, not successful manual recovery. | Added Playwright coverage for outage -> recheck success while Register stays open. |

## Device and Network Matrix

| Device | LAN expected behavior | Tailscale/off-network expected behavior | Notes |
|---|---|---|---|
| Register # devices | Use saved LAN/Main Hub URL; open session hydrates without shell bounce; outage banner blocks new risky work. | Supported if Tailscale address is saved, but remote POS checkout is not the normal use case. Printing/cash drawer still require local hardware access. | Sale completion can queue only when offline checkout recovery rules apply; register close waits for recovery queue clearance. |
| Back Office/Main Hub desktop | Same-origin or loopback URL; Windows Tauri server station can start installed local server when configured. | Use saved `100.x.x.x` or `.ts.net` host; sign-in gate shows Tailscale warning when unreachable. | Bounded startup fetches prevent a stuck sign-in gate. |
| PWA clients | Same-origin API base when opened from the Main Hub URL; responsive PWA coverage exists. | Same-origin Tailscale URL or saved override; CORS origins must include Tailscale host. | PWA cache/update behavior still needs live device smoke before go-live. |
| Tauri apps | Runtime override and desktop fallback route API calls through shared base resolver. | Saved Tailscale override works for API calls; native printing remains local-device dependent. | Tauri hardware paths must be validated on actual register hardware. |
| Server/Main Hub machine | Runs API, DB access, background jobs, health endpoint, deployment manager tooling. | Must keep Tailscale service connected and firewall/CORS scoped to Tailscale origins. | Production DB query plans still need measurement on current data volume. |

## Remaining GO-LIVE Risks

- Production-sized query plan verification is still required for customer search, order lookup, register-day activity, and wedding dashboard loads. Existing read-path indexes are present, but this review did not execute `EXPLAIN ANALYZE` against the live production dataset.
- Real-device network smoke is still required for Register # hardware, Back Office/Main Hub desktop, PWA clients, Tauri app, and an off-network Tailscale device.
- Tauri/PWA parity for API connectivity is code-aligned, but native printing, cash drawer, and Helcim terminal behavior require hardware validation on the target stations.
- Server restart and network-drop recovery are covered at the UI contract level for Register preservation and connection banner recovery; full end-to-end sale/payment interruption recovery still requires a live Main Hub and terminal test.

## Recommendation

ROS is closer to smooth multi-device operation after the fixes in this review, but the release should remain CAUTION, not GO, until the listed production data and real device smoke tests pass on the actual Main Hub, Register # devices, Tauri app, PWA clients, and one off-network Tailscale client.

## Validation Run

| Command | Result |
|---|---|
| `npm --prefix client run typecheck` | Passed |
| `npm --prefix client run lint` | Passed |
| `npm --prefix client run test:e2e -- e2e/register-state-stability.spec.ts --workers=1` | Passed, 5 tests |
| `npm --prefix client run test:e2e -- e2e/offline-recovery-contract.spec.ts --workers=1` | Passed, 2 tests |
| `npm run check:help-impact -- --help-not-needed` | Passed |
| `npm run check:server` | Passed with existing `imap-proto` future-incompat warning |
| `bash scripts/cargo-server.sh test transaction_fulfillment` | Passed, 3 targeted tests |
| `cargo fmt --manifest-path server/Cargo.toml --check` | Passed |
| `npm --prefix client run test:e2e -- --workers=1` on release commit `6064e91c` | Passed, 373 passed and 11 skipped |
| GitHub release workflows for release commit `6064e91c` | Passed: Lint Checks, Playwright E2E, macOS ROS Dev Center Release, Windows deployment package |
