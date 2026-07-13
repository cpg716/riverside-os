# Performance and Session Integrity Review — 2026-07-12

## Executive summary

The Tauri, PWA/browser, LAN, and Tailscale runtime paths were traced from API-base selection through health monitoring, authentication middleware, PostgreSQL use, Register token validation, and Station Fleet telemetry. The most important confirmed defect was that Back Office Staff Access was not a server session: the raw four-digit PIN was retained in tab storage, sent on every request, and Argon2-verified repeatedly. This was both a security weakness and avoidable CPU cost.

Riverside now issues a separate opaque Staff Access session for each Tauri window, installed PWA, or browser tab. Only the token hash is stored server-side; the client retains no PIN. Sessions are bound to the physical station and connection instance, expire, revoke independently on sign-out, revoke globally on PIN change/deactivation, and expose active staff evidence in Station Fleet. Register token activity and Staff session activity writes are throttled so normal read traffic no longer causes a write on every authenticated request.

## Runtime paths reviewed

- **API host selection:** browser/PWA uses same-origin by default; packaged Tauri can use its saved Main Hub/LAN/Tailscale host and retains the explicit loopback fallback for a true local host installation.
- **PWA lifecycle:** Workbox excludes `/api` navigation from cached fallback, uses a prompt-based update, and does not cache API responses as application data.
- **Connection recovery:** the shared connection monitor uses bounded health requests, a slower healthy interval, a faster offline interval, and immediate recovery probes on browser network events. Staff heartbeats also resume on reconnect and visibility return.
- **Tauri security:** the WebView now has an explicit CSP. Approved API transport over LAN/Tailscale and the HelcimPay host remain usable; arbitrary remote scripts and object/plugin content are blocked.
- **Database pool:** startup maintains a small warm pool and bounds acquisition, idle, and maximum connection lifetime. Environment overrides remain available for measured production tuning.
- **Outbound provider HTTP:** the shared server client now has bounded connect/request timeouts, TCP keepalive, idle connection reuse, and a per-host idle pool cap.
- **Register sessions:** open-Register tokens remain station-bound and are validated on every protected call. Their `last_used_at` write is now limited to once per minute.
- **Staff sessions:** session token, station identity, connection identity, active-staff status, expiry, and revocation are validated server-side. Permission resolution remains server-side after identity validation.
- **Operations visibility:** Station Fleet reports active Staff Access count and staff names per station in addition to runtime surface and heartbeat state.

## Fixes implemented

1. Added migration `125_staff_access_sessions.sql` for hashed, expiring, independently revocable Staff Access sessions.
2. Added `POST|DELETE /api/staff/session` and session-aware shared authentication middleware.
3. Removed raw PIN persistence from the Riverside UI and automatically deletes the legacy v1 storage payload.
4. Bound every UI Staff session to station and per-window connection keys; secret headers remain excluded from offline persistence.
5. Revoked sessions on explicit sign-out, Access PIN change, admin PIN reset, and staff deactivation.
6. Added client-side expiry enforcement and server-side fixed expiry (16 hours by default, configurable from 1–24 hours).
7. Throttled Staff and Register last-seen writes to once per minute.
8. Added active Staff-session evidence to both Station Fleet views.
9. Warmed and bounded the PostgreSQL connection pool and hardened the shared outbound HTTP pool.
10. Enabled an explicit Tauri CSP compatible with LAN/Tailscale API traffic and the approved HelcimPay runtime.
11. Added focused API coverage proving issuance, connection binding, authenticated use, revocation, and post-revocation rejection.
12. Classified valid Staff sessions in the authenticated traffic budget and added a separate 20-attempt-per-minute Access-PIN ceiling per source IP.
13. Stopped trusting spoofable forwarded-client-IP headers by default; deployments may opt in only when a controlled reverse proxy overwrites them.
14. Removed Z-close reconciliation's dependency on a retained four-digit credential; its scoped Staff/Register session now authorizes the state change, and close/handoff audit attribution resolves the actual authenticated Staff session.

## Confirmed healthy behavior requiring no code change

- PWA/browser same-origin API resolution avoids needless CORS and connection setup when Riverside is served by the Main Hub.
- API calls are not cached by the service worker.
- Connection health checks are bounded and adaptive rather than a fast constant polling loop.
- Station heartbeats are non-blocking and do not clear a valid identity during a transient network interruption.
- Strict production startup already refuses a missing CORS allowlist; non-strict permissive CORS remains clearly logged for development.
- Register sessions remain separate from Staff Access sessions. Joining a Register does not turn its station token into a general Staff identity.

## Operational settings

- `RIVERSIDE_STAFF_SESSION_HOURS`: Staff Access lifetime, integer 1–24; default 16.
- `RIVERSIDE_STAFF_SIGN_IN_RATE_LIMIT_PER_MINUTE`: per-IP Staff Access PIN attempt ceiling; default 20.
- `RIVERSIDE_TRUST_PROXY_HEADERS`: defaults false; enable only behind a controlled proxy that overwrites forwarded IP headers.
- `RIVERSIDE_DATABASE_MAX_CONNECTIONS`: existing database pool maximum.
- `RIVERSIDE_DATABASE_MIN_CONNECTIONS`: warm pool minimum; default is the smaller of 3 and the configured maximum.
- `RIVERSIDE_DATABASE_ACQUIRE_TIMEOUT_SECS`: pool wait limit, 2–30 seconds; default 10.
- `RIVERSIDE_CORS_ORIGINS` plus `RIVERSIDE_STRICT_PRODUCTION=true`: required for production browser/PWA hosts.

## Remaining production sign-off

These are deployment proofs, not unresolved source defects:

1. Run a physical Windows Tauri station and one installed PWA through a 30+ minute idle/reconnect test on the actual store LAN.
2. Repeat the reconnect test through the deployed Tailscale HTTPS URL and confirm the production CORS allowlist contains that exact origin.
3. Confirm Station Fleet shows the correct active staff separately when two devices or tabs sign in concurrently.
4. Retire the legacy raw code/PIN header fallback after all scripts and external integrations have migrated to Staff sessions. It remains temporarily compatible; the shipped UI no longer uses it for normal requests.
5. Existing open-Register tokens predate hashed Staff sessions and remain server-stored opaque values. Converting them to hash-only storage should be a separate rollout with compatibility for already-open tills, not an in-place release change.

The inactive online storefront/web-checkout path was recorded but intentionally not treated as a blocker or expanded in this review.

## Validation performed

- Clean `riverside_os_e2e` database reset, migrations 001–125 applied, and migration-ledger checksums verified with no drift.
- `cargo check -p riverside-server`.
- Staff-session token unit test and all six focused rate-limit unit tests.
- Frontend TypeScript typecheck and ESLint.
- Focused Playwright: Staff session issue/bind/revoke contract; 4-digit sign-in to Operations; reload persistence with no retained Access PIN; session-authorized Register reconciliation and Z-close discrepancy guard.
- `npm run check:go-live-blockers`: 79 gates passed, including permanent session/CSP/rate-limit guards.
- Help manifest generation and Help-impact gate.
- Tauri configuration inspection confirmed the CSP is parsed and active. Local macOS packaging was not run because Xcode is not installed; Windows remains the production desktop target.
