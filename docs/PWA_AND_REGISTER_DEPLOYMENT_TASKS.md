# PWA + desktop Register — deployment checklist

**Intent:** The deployment model is role-based: one Windows Tauri machine is the **HOST machine**, a different Windows Tauri machine is the **MAIN REGISTER**, local-network PWA access is for devices on the same network as the host, and **remote access** is a separate Tailscale path for off-site devices. This file tracks **repo implementation** plus **one-time store sign-off** before production.

Related: [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) (Tailscale / TLS), [`DEVELOPER.md`](../DEVELOPER.md) (build commands), [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md), [`TRANSACTION_RETURNS_EXCHANGES.md`](TRANSACTION_RETURNS_EXCHANGES.md) (`/api/transactions/*` routes with `orders.*` RBAC), [`SEARCH_AND_PAGINATION.md`](SEARCH_AND_PAGINATION.md) (POS customer + inventory directory paging), **[`REGISTER_DASHBOARD.md`](REGISTER_DASHBOARD.md)** (POS **Dashboard** tab, metrics, notifications, **`weddings.view`** on morning board APIs), **[`TILL_GROUP_AND_REGISTER_OPEN.md`](TILL_GROUP_AND_REGISTER_OPEN.md)** (lanes **66–67**, one drawer + satellite registers, combined Z-close), **[`POS_PARKED_SALES_AND_RMS_CHARGES.md`](POS_PARKED_SALES_AND_RMS_CHARGES.md)** (migrations **68–69**: server **Park**, Z-close purge, **`pos_rms_charge_record`** **charge** vs **payment**, Sales Support **notifications** + **tasks**, **Customers → RMS charge**, QBO **`RMS_R2S_PAYMENT_CLEARING`**, optional **`VITE_POS_OFFLINE_CARD_SIM`**).

---

## A. Build targets and configuration

- [x] **Three artifacts:** (1) server binary + `client/dist`, (2) PWA (same bundle served by Axum or CDN), (3) Tauri installer (`npm run tauri:build` in `client/`).
- [x] **`VITE_API_BASE` per environment** — set at Vite build time when UI and API differ; when unset, browser/PWA builds use same-origin and desktop/non-HTTP shells fall back to `http://127.0.0.1:3000`.

| Environment | Example `VITE_API_BASE` |
|-------------|-------------------------|
| Dev | *(omit)* → same-origin browser `/api/*` via Vite proxy; desktop/non-HTTP fallback `http://127.0.0.1:3000` |
| LAN | `http://ros-server.local:3000` |
| Tailscale / HTTPS | `https://your-host...` (see `REMOTE_ACCESS_GUIDE.md`) |

- [x] **Separate PWA vs register builds:** `client/.env.pwa.example`, `client/.env.register.example` (copy to `.env.pwa` / `.env.register`, gitignored). Scripts: `npm run build:pwa`, `npm run build:register`. Tauri uses `beforeBuildCommand`: `npm run build:register` in `client/src-tauri/tauri.conf.json`.
- [x] **Version display:** Settings → General → **About this build** (semver, git SHA, Tauri version, API base).

### A.1 Current release artifact status (2026-05-01)

- [x] Target app version is now **`v0.4.0`** for the deployment-audit release candidate.
- [ ] **`v0.4.0` Windows installer/updater assets are not published yet.** Required Windows release artifacts are `latest.json`, the Windows MSI, and the `.sig`.
- [x] Previous updater proof exists: **`v0.2.1`** release includes `latest.json`, MSI, and `.sig`.
- [ ] Before installing Windows stations for **`v0.4.0`**, run the Windows updater release workflow, use a manual workflow artifact, or produce an approved local Windows build and record the artifact URL.
- [ ] Latest `main` **Lint Checks** must be green before calling the current head release-ready. The previous GitHub run failed on a Meilisearch helper too-many-arguments lint; the local v0.4.0 readiness fix refactors that helper, and CI still needs a fresh run after commit/push.
- [ ] Latest `main` **Playwright E2E** must be green before calling the current head release-ready. The later GitHub run at `ef1f6a28` failed the individualized-shirt order contract; the local v0.4.0 readiness fix now passes that targeted slice, and CI still needs a fresh run after commit/push.

---

## B. PWA installability and polish

- [x] **Manifest + icons:** `client/public/manifest.json` (source); production emits `dist/manifest.json` via `vite-plugin-pwa`. Icons: `client/public/icon-192.png`, `icon-512.png`.
- [x] **Theme colors:** Manifest + `index.html` `theme-color` meta (`prefers-color-scheme`).
- [x] **Service worker:** `vite-plugin-pwa` (`generateSW`, `registerType: "prompt"`). **`PwaUpdatePrompt`** (production) offers **Reload now** / **Later** when a new SW is waiting. Workbox `navigateFallbackDenylist` excludes `/api/*`.
- [x] **iOS Safari:** Automated coverage is limited; **manually** on a physical device: login, Stripe (if used), CSV/import upload, 30+ minute session, and “Add to Home Screen”. Watch for storage eviction if the device is low on space.
- [x] **Responsive QA:** Playwright `client/e2e/pwa-responsive.spec.ts` (375px + 768px). Run: `E2E_BASE_URL=http://localhost:5173 npm run test:e2e -- e2e/pwa-responsive.spec.ts`.
- [x] **API gate smoke:** `client/e2e/api-gates.spec.ts` — anonymous **401/403** on sample gated routes when **`E2E_API_BASE`** (default `http://127.0.0.1:3000`) is reachable; skips if API is down. Full Playwright/API smoke inventory: **`docs/E2E_REGRESSION_MATRIX.md`**.

---

## C. Network, TLS, and remote access

- [x] **HTTPS in production:** Follow [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) (Tailscale Serve, reverse proxy, or equivalent). Do not expose plain HTTP to the public internet for staff-facing PWA.
- [x] **CORS:** `server/src/main.rs` / `launcher.rs` — when **`RIVERSIDE_CORS_ORIGINS`** is unset, `allow_origin(Any)` (dev/Tauri). Production browser hosts should set **`RIVERSIDE_STRICT_PRODUCTION=true`** so startup refuses missing CORS allowlists, missing storefront JWT secret, and invalid `FRONTEND_DIST`.
- [x] **Server bind:** Defaults to `0.0.0.0:3000`. Override with **`RIVERSIDE_HTTP_BIND`** (e.g. `127.0.0.1:3000` behind a local reverse proxy).
- [x] **Dedicated host smoke check:** the host panel now shows the host machine's local satellite URL plus detected LAN identity, so stores can verify a second same-network device loads the sign-in gate before opening.

---

## D. Tauri register (desktop)

- [x] **Release pipeline:** Local: `npm run tauri:build` from `client/` (runs `build:register` first). CI template: `.github/workflows/tauri-register-build.yml` (Windows, `workflow_dispatch`). Add a code-signing step before `tauri build` if SmartScreen requires it.
- [x] **Windows 11 smoke:** Use `docs/WINDOWS11_TAURI_SMOKE_CHECKLIST_V021.md` for release sign-off on v0.2.1 auth/identity hardening (Unified Guard, authenticated staff persona priority, restricted POS Settings, POS hardware access).
- [x] **Thermal / ESC-POS:** **Desktop / Tauri:** `client/src/lib/printerBridge.ts` → Tauri `invoke("print_*")` → `client/src-tauri/src/hardware.rs` TCP to printer. **PWA / browser:** same module falls back to `POST /api/hardware/print`, then browser print fallback.
- [x] **Auto-update (desktop):** Tauri updater is supported via the release workflow `.github/workflows/tauri-register-updater-release.yml`. It emits `latest.json` + signed Windows updater artifacts for your hosted update endpoint.
- [x] **Kiosk-ish (optional):** Not bundled; use Windows assigned access / shell replacement, or Tauri fullscreen + `tauri-plugin-single-instance` if you add it later.

### D.1 Windows install paths

Use one of these paths for each Windows station:

1. **Current release installer:** run `.github/workflows/tauri-register-updater-release.yml` for the target version, then install from the release assets.
2. **Manual build artifact:** run `.github/workflows/tauri-register-build.yml`, download `tauri-windows-bundle`, and install the bundle on the station.
3. **Local Windows build:** copy `client/.env.register.example` to `.env.register`, set `VITE_API_BASE`, then run `npm ci` and `npm run tauri:build` from `client/`.

Station role rules:

- **Backoffice / Server PC:** may run the server and Shop Host; do not confuse it with Register #1.
- **Register #1:** Windows Tauri cashier station; owns the cash drawer and physical receipt workflow.
- **Other Windows laptops:** use browser-installed PWA unless the station needs native Tauri hardware paths.
- **iPad Register #2:** PWA satellite lane; thermal receipt printing still routes through Register #1 or another Windows Tauri station today.

---

## E. Auth, sessions, and security

- [x] **Session lifetime / shared iPads:** Register session lives until close; there is no long-lived browser JWT. **Training:** log out or close the register when leaving a shared device; back-office actions re-verify PIN when configured.
- [x] **Admin headers / PIN:** Same code paths for PWA and Tauri; no dev auth bypass in middleware (see project invariants).
- [x] **Orders / refunds / returns:** Back Office **Orders** and refund/return actions require the `orders.*` permission keys (migration **36**); behavior and endpoints are summarized in `docs/TRANSACTION_RETURNS_EXCHANGES.md` and `docs/STAFF_PERMISSIONS.md`.
- [x] **POS Dashboard / morning board:** Register opens to **Dashboard** by default (see **`docs/REGISTER_DASHBOARD.md`**). **`GET /api/weddings/morning-compass`** and **`activity-feed`** require staff auth + **`weddings.view`**; floor staff without that key still get tasks/notifications/metrics where permitted. Train stores that **Operations** wedding widgets need **`weddings.view`**.
- [x] **Secrets:** Client bundle exposes only `VITE_*` (today: `VITE_API_BASE`). Stripe, QBO, DB, and `STRIPE_SECRET_KEY` stay server-side (`server/src/main.rs`).

---

## F. Offline and degraded operation

- [x] **POS offline queue:** Documented in `client/src/lib/offlineQueue.ts`. **Queued:** checkout payload when offline. **Not queued:** session open/close, BO writes. **Flush:** on `online`, queue syncs to `/api/transactions/checkout`.
- [x] **User-visible copy:** Header now shows explicit **Offline: POS checkout can queue** and **Pending syncs** pills; checkout offline toast; failed checkout / session bootstrap toasts reference Settings (General) for API URL. Production-only toast on initial session fetch failure (avoids dev noise).
- [x] **Wedding / BO offline:** Mutations require API; no silent persistence beyond the POS checkout queue above.
- [x] **Customer & inventory lookup (online):** POS **client search**, **customer picker**, and **fuzzy product search** call `/api/customers/*` and `/api/products/control-board` (or `/api/inventory/scan`). None of this is queued offline—only **checkout** is. On Tailscale / cellular, expect extra latency on first keystrokes; very large directories use **Load more** / paging (**`docs/SEARCH_AND_PAGINATION.md`**).

---

## G. Quality gates

- [x] **Playwright / CI:** `E2E_BASE_URL=http://localhost:5173 npm run test:e2e` (see `client/playwright.config.ts`). For stable ordering under load use `npx playwright test --workers=1` from `client/`. PWA viewports: `e2e/pwa-responsive.spec.ts`. Visual baselines + UI consistency QA notes: **`docs/ROS_UI_CONSISTENCY_PLAN.md`** Phase 5. Tauri: manual smoke (open app, session, one sale, one print) — E2E does not drive the native shell.
- [x] **Load / soak (light):** Before a big weekend, run ~1 h register session + 2–3 PWA tabs (insights, orders) against staging; watch server CPU/DB connections. If the store has a **large customer or SKU count**, spot-check **PWA over the same network path staff will use** (Wi‑Fi vs Tailscale): customer attach, register line-item search, and **Inventory** list search should return matches without timing out.
- [x] **Backup/restore drill:** Execute once per `BACKUP_RESTORE_GUIDE.md` on a non-production copy before go-live.

### G.1 Deployment smoke matrix (required sign-off)

- [ ] **Dedicated HOST machine:** Shop Host starts, shows running state, shows frontend bundle, shows at least one local satellite URL, and passes a second-device same-network smoke.
- [ ] **MAIN REGISTER machine:** Windows Tauri register checklist passes on the dedicated cashier station.
- [ ] **Local iPad PWA:** same-network URL works from the host, Add to Home Screen works, tablet shell/search/status flow is readable.
- [ ] **Local phone PWA:** same-network URL works from the host, phone shell/search/status flow is readable, and no horizontal overflow appears.
- [ ] **Remote PWA over Tailscale:** off-site device reaches the store through the Tailscale remote path and is not using the local host URL by mistake.

---

## H. Operational runbooks

### PWA will not load

1. Reachability: open `VITE_API_BASE` from the device browser.
2. Tailscale / DNS: [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md).
3. HTTPS clock skew and certificate validity.
4. Hard refresh; clear site data or reinstall the home screen icon.
5. Collect **Settings → General → About this build** (version, git, API base).

### PWA install / update contract

1. On **Windows laptops** and supported mobile browsers, use Riverside's **Install app** prompt when it appears.
2. On **iPad / iPhone**, use **Share → Add to Home Screen** and launch Riverside from the icon instead of a browser tab.
3. When the **PWA update prompt** appears, use **Reload now** after the active task or sale is at a safe stopping point.
4. If the shell still looks stale after reload, close and reopen the installed icon first, then fall back to clear site data or reinstall only if needed.

### Register app will not print

1. Printer IP/port; ping from the PC.
2. Windows firewall outbound to printer (often TCP 9100).
3. Tauri path: native `hardware` vs PWA path: `/api/hardware/print` (see `printerBridge.ts`).
4. Full restart of the desktop app after network changes.

---

## Store sign-off (execute on your environment)

Check when done on **your** production or staging URLs:

- [ ] Production HTTPS end-to-end for the PWA origin you hand to staff.
- [ ] Physical iOS device pass (login, payments, long session) if iPhones are in scope.
- [ ] Windows installer signed or SmartScreen acceptance documented.
- [ ] Backup create + restore drill logged with date/operator.

When the above sign-off boxes are ticked, you are ready for pilot → full deployment.
