# Riverside OS — Full store deployment guide

This document is the **canonical production deployment** reference for a typical shop layout:

- **One Windows PC** is the **HOST machine**. It runs **PostgreSQL** and the **Riverside OS server** (Rust Axum API + static web UI from `client/dist`) and may also run the hardened Tauri **Shop Host** surface.
- **A different Windows PC** is the **MAIN REGISTER**. It uses the **Windows desktop app** (Tauri 2) as the primary cashier station.
- **Local-network iPads and phones** use the **Progressive Web App** against the host machine while they are on the same shop network.
- **Remote access** is separate: off-site PWA devices use **Tailscale** to reach the same host machine over a private remote path.
- **Other office PCs** use a browser or optional Tauri against the same API origin.

Deeper checklists and remote access detail live in linked docs at the end.

---

## 1. Architecture snapshot

### 1.1 Host engine verification (macOS dev / pre-prod)

If your team uses macOS for local validation before Windows production cutover, verify the Docker engine context before any DB or migration operation:

- `docker context show` should return **`orbstack`**.
- `docker info` should identify **OrbStack** as the runtime.
- `docker compose ps` should show expected services healthy (`db`, optional local-dev `meilisearch`, optional `metabase` stack).

Record this verification in your deployment log so troubleshooting always starts from a known container runtime.

There is **one application backend** and **one database**. Every client device talks to the **same API origin** (for example `https://ros.yourstore.tld` or `http://server-pc:3000` on the LAN).

```mermaid
flowchart TB
  subgraph serverHost [Server PC]
    Axum[Axum API plus static SPA]
    PG[(PostgreSQL)]
    Axum --> PG
  end
  Reg1[Tauri Register 1]
  BO[Tauri Back Office]
  iPad[PWA Register 2 iPad]
  PCs[Browser office PCs]
  Phones[PWA phones Tailscale]
  Reg1 -->|HTTPS or LAN HTTP| Axum
  BO -->|HTTPS or LAN HTTP| Axum
  iPad -->|HTTPS recommended| Axum
  PCs --> Axum
  Phones -->|Tailscale HTTPS| Axum
```

- The server listens on **`0.0.0.0:3000`** by default so **LAN and Tailscale** clients can reach it. Override with **`RIVERSIDE_HTTP_BIND`** if you terminate TLS on a reverse proxy and bind the app to loopback only (see [`DEVELOPER.md`](../DEVELOPER.md) environment table).

**Meilisearch on Windows Main Hub:** The packaged Windows Main Hub deployment installs a local **Meilisearch** runtime, registers the **Riverside OS Meilisearch** startup task, and configures the API for `http://127.0.0.1:7700`. PostgreSQL remains authoritative; Meilisearch is the fast search copy for inventory, CRM, wedding, order, transaction, alteration, Help Center, and storefront PLP search. Meilisearch does not watch PostgreSQL by itself: full rebuilds are admin-triggered, and automatic updates happen only on ROS write paths that explicitly upsert the affected search document. After deploy, restore, Meilisearch wipe, database reset, or major Counterpoint import, run **Settings → Integrations → Meilisearch → Rebuild search index** (or **`POST /api/settings/meilisearch/reindex`**). Details: [`SEARCH_AND_PAGINATION.md`](SEARCH_AND_PAGINATION.md).

---

## 2. Roles and recommended client

| Role | Recommended client | Notes |
|------|-------------------|--------|
| **Backoffice / Server PC** | Windows PC running services + optional Tauri | Run PostgreSQL and `riverside-server` here. If you use Shop Host, this is the one Tauri machine that should serve local-network satellite clients. This PC should stay on and be on UPS if possible. |
| **Register #1** | **Tauri (Windows)** | Separate from the host machine. This is the primary cashier station and the preferred surface for **physical receipt print** from the post-sale flow (see section 6). |
| **Register #2** | **iPad PWA** | Use the local satellite URL shown by the host when the iPad is in the store. Add to Home Screen. Network printer dispatch can work when the API host can reach the printer IP; installed-printer dropdowns and local readiness checks require a Windows Tauri station. |
| **Back office workstation** | Browser or optional Tauri | Same API origin and auth model; optional Tauri if you want a dedicated shell. |
| **Other Windows PCs / laptops** | **PWA or optional Tauri** | Use a browser-installed PWA for Back Office/POS where hardware printing is not required; use Tauri where native printer/scanner reliability is required. |
| **Off-site phones / laptops** | **PWA over Tailscale** | Use **Tailscale** (or equivalent private mesh) and **HTTPS** when the device is not on the same local network as the host. Do not expose plain HTTP to the public internet for staff apps ([`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md)). |

### 2.1 Current deployment status snapshot (2026-06-04)

This is the current repo/deployment status to verify before a live install:

| Item | Current status | Deployment impact |
|------|----------------|-------------------|
| Target release version | **`v0.90.0`** | Root, client/PWA bundle, server, Tauri, standalone apps, and deployment metadata must all match. Run `npm run check:version` before publishing artifacts. |
| Latest published GitHub release | **`v0.90.0`** | Use the release workflow output for the current release; do not mix installer assets from older releases. |
| Windows installer/updater assets | **Required for the same Riverside release** | The release must contain `latest.json`, one current Windows MSI, and the matching `.sig`; old Riverside MSI/signature assets must be removed before upload. |
| Windows deployment package | **Required as GitHub release asset for Main Hub/full go-live updates** | `RiversideOS-v0.90.0-*-Windows-Deployment.zip` includes server, client bundle, register installer, Deployment Manager, migrations, seeds, and PowerShell scripts. |
| Windows app updater-only release | **Available for faster Back Office/Register desktop app updates** | Workflow scope `app-updater-only` publishes the signed Tauri app updater assets without rebuilding the full deployment ZIP or unchanged companion apps. |
| macOS ROS Dev Center | **Required as GitHub release asset** | Universal Apple Silicon / Intel DMG for Mac-based DevOps companion access and system management. |
| Latest Playwright E2E on `main` | Must pass on the final `v0.90.0` release commit | Rerun GitHub checks on the release commit before calling the code gate green. |
| Latest Lint Checks on `main` | Must pass on the final `v0.90.0` release commit | Rerun GitHub checks on the release commit before calling the code gate green. |
| Local go-live checklist | Human/hardware/accounting gates still open | Retail deployment remains **pilot/validation**, not unattended go-live. |

Before installing the two Windows PCs and PWA devices for production use, publish one complete Riverside release and record its release/run URL in the deployment log. The Windows app, server API, and PWA/web app files must all report the same Riverside version.

For a near-turnkey Windows setup package, use the graphical **Deployment Manager** (see [`DEPLOYMENT_MANAGER.md`](DEPLOYMENT_MANAGER.md)) or follow the script parameters in [`WINDOWS_INSTALLER_PACKAGE.md`](WINDOWS_INSTALLER_PACKAGE.md). The deployment manager automates the Main Hub install, migration apply, startup task, firewall rule, Register #1 desktop install, station API base, and printer settings import.

### Till shift: Register #1 and satellite lanes

The app supports **multiple open register terminals** sharing one **till close group**: **Register #1** is the **cash drawer** (opening float, paid in/out, **Z-close**). **Register #2+** link to an open **#1** session (**$0** satellite float); **Z** on **#1** closes **all** lanes in the group. Train staff that **physical cash** for the day lives in the **#1** drawer even when tenders post from **#2**. Full behavior: **[`docs/TILL_GROUP_AND_REGISTER_OPEN.md`](TILL_GROUP_AND_REGISTER_OPEN.md)**.

---

## 3. Build and release artifacts

### 3.1 Server (shop server PC)

- **Rust binary** for the API (`cargo build --release` in `server/`, or your CI artifact). The server pins **Rust 1.88+** in **`server/rust-toolchain.toml`** (**`ort`** / **fastembed** for staff-help embeddings); use that toolchain in CI and release builds.
- **Production web bundle** `client/dist` copied next to the deployment layout your runbook uses (Axum serves this folder in production).
- **Database**: PostgreSQL reachable via **`DATABASE_URL`**. Apply the active schema-contract baseline and approved seed set (see [`DEVELOPER.md`](../DEVELOPER.md) and [`SCHEMA_CONTRACT_AND_MIGRATIONS.md`](SCHEMA_CONTRACT_AND_MIGRATIONS.md)). If you ship ROS-AI help, set **`RIVERSIDE_REPO_ROOT`** to the deployed tree that contains **`docs/staff/CORPUS.manifest.json`** and run **`POST /api/ai/admin/reindex-docs`** after upgrades that change staff docs — [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md).

#### 3.1.1 Backoffice / Server PC first-time setup

Use this checklist for the Windows PC that owns the store database and API:

**Automated path:** Build the Windows deployment package, run **`Start-RiversideDeployment.cmd`** as Administrator on the Server PC, and select the **Backoffice / Server** target (see [`DEPLOYMENT_MANAGER.md`](DEPLOYMENT_MANAGER.md)).

1. Install **PostgreSQL 16** (or a vetted hosted/local PostgreSQL 16 equivalent) and create the Riverside database/user.
2. Install or place the **`riverside-server.exe`** release binary in a stable folder, for example `C:\RiversideOS\server\`.
3. Place the built web bundle in a stable folder, for example `C:\RiversideOS\client\dist\`.
4. Create a server environment file or service environment with at least:
   - `DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/riverside_os`
   - `FRONTEND_DIST=C:\RiversideOS\client\dist`
   - `RIVERSIDE_HTTP_BIND=0.0.0.0:3000` for LAN/PWA access, or `127.0.0.1:3000` only when a reverse proxy handles remote clients
   - `RIVERSIDE_STRICT_PRODUCTION=true` for browser/PWA production
   - `RIVERSIDE_CORS_ORIGINS=` with every browser/PWA origin staff will use
   - `RIVERSIDE_STORE_CUSTOMER_JWT_SECRET=` with a long random value
   - payment, QBO, backup, Meilisearch, and integration secrets as needed for the store
5. Apply the schema-contract baseline from the release bundle using `scripts/apply-migrations-psql.sh` or the manual `psql` sequence in [`LOCAL_UPDATE_PROTOCOL.md`](LOCAL_UPDATE_PROTOCOL.md), then apply the approved production seed set.
6. Start the API manually once and confirm the log says it is listening on the expected bind address.
7. Open Windows Firewall inbound **TCP 3000** only for trusted LAN/Tailscale networks.
8. Configure the final run method:
   - The Windows deployment package creates the scheduled task **`Riverside OS Server`**. Keep that exact task name so the Backoffice / Server desktop app can recover the local server automatically when it opens and `localhost` is not responding.
   - If using a store-specific Windows service instead, record the exact start/stop command in the store deployment log and do not expect desktop app auto-start recovery to control that service.
9. Open the app from the server PC browser and confirm staff sign-in, **Settings → General → About this build**, **Settings → Updates**, and **Settings → Remote Access**.
10. If this PC is also the **Shop Host**, start **Shop Host** from **Settings → Remote Access** and smoke-test a second device on the same network before opening.
11. Confirm the ROSIE AI stack is available by checking the **Bug Reports** panel or triggering an AI action (requires the installer to have downloaded the local model successfully).

#### 3.1.2 Public webhooks and Cloudflare Tunnel

Helcim terminal approvals and terminal cancels are most reliable when Helcim can deliver signed webhooks to the ROS API. The production delivery URL for the Riverside store is:

```text
https://ros.riversidemens.com/api/webhooks/helcim
```

If that hostname is backed by Cloudflare Tunnel, production must run `cloudflared` as a supervised host service on the machine that can reach the ROS API on port `3000`. The deployment installer and **Settings → Remote Access → Repair Cloudflare Tunnel** can repair the local tunnel origin when `RIVERSIDE_CLOUDFLARE_TUNNEL_HOSTNAME` is configured, but Cloudflare DNS/WAF records still live in Cloudflare.

Production checklist:

1. **Settings → Remote Access** shows the public base URL and Cloudflare tunnel hostname.
2. **Repair Cloudflare Tunnel** verifies or updates the local `cloudflared` ingress to `http://127.0.0.1:3000`.
3. The `cloudflared` service or scheduled task is configured with restart-on-failure behavior.
4. `HELCIM_WEBHOOK_SECRET` or the encrypted Settings -> Helcim webhook secret matches the Helcim webhook verifier/signing token.
5. Helcim webhooks are enabled for `cardTransaction` and `terminalCancel`.
6. **Run Live Callback Check** in Settings -> Remote Access reaches this ROS server; Cloudflare `502`, `1033`, `403`, or challenge HTML means Helcim cannot reach ROS.
7. A real terminal approval and terminal cancel both appear in Payments -> Health under Payment Updates.

#### 3.1.2 Minimum server acceptance checks

- [ ] `DATABASE_URL` points at the intended production database, not dev/staging.
- [ ] `ros_schema_migrations` matches the active migration files in the release bundle.
- [ ] Schema contract validation passes against the production database.
- [ ] `FRONTEND_DIST` points at the deployed `client/dist` and contains `index.html`.
- [ ] `RIVERSIDE_STRICT_PRODUCTION=true` starts successfully.
- [ ] Server URL loads from another machine on the store LAN.
- [ ] Backup path is writable and visible in Settings.
- [ ] Meilisearch status is connected on the Main Hub and rebuilt after import/reset.
- [ ] If Shop Host is used, the local satellite URL opens the sign-in gate from a second device.

### 3.2 Windows desktop app (Register 1 + Back office)

1. Copy [`client/.env.register.example`](../client/.env.register.example) to **`client/.env.register`** (gitignored).
2. Set **`VITE_API_BASE`** to the origin **each PC can reach** (LAN IP or hostname of the server, or your HTTPS URL). Avoid `http://127.0.0.1:3000` unless the API truly runs on that same machine.
3. From **`client/`**: `npm run tauri:build` (runs the register build first per Tauri config).

Installer signing and CI notes: [`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) section D.

#### 3.2.0 Getting the Windows installer

Use one of these paths:

1. **Current release path:** run **Windows deployment package** (`.github/workflows/windows-deployment-package.yml`) for the target version. It publishes the full deployment ZIP plus the signed Windows updater manifests/artifacts to the matching GitHub release.
2. **Local build path:** on a Windows build machine with Rust/Node prerequisites, build from `client/` with `npm ci` then `npm run tauri:build`.

Record the installer version, GitHub run URL or release URL, and target API base in the deployment log. Do not reuse an older installer just because it is present on the release; confirm **Settings → Updates** shows one expected **Riverside version**.

After first install, desktop station updates are handled in ROS from **Settings → Updates → Windows app**. The release version must still match the server and PWA/web app files. If **Settings → Updates** shows **Update incomplete**, finish the matching server or station update before continuing operations.

#### 3.2.1 Tauri station install checklist (per Windows station)

- [ ] If using the deployment package, run **`install-register.ps1`** as Administrator so the desktop app, API base, and printer station settings are installed together.
- [ ] Confirm Windows user account and local admin rights for install/update.
- [ ] Install the correct Riverside desktop artifact for the release version.
- [ ] Confirm the installed Windows app icon is the Riverside logo mark, not the old solid red placeholder.
- [ ] Launch app and verify **Settings → General → About this build** shows expected app version + API base.
- [ ] Confirm station reaches API origin and can sign in with staff PIN flow.
- [ ] Confirm station-specific **Printers & Scanners** values are set (receipt/tag/report destinations).
- [ ] Confirm scanner input reaches focused fields as keyboard wedge text.
- [ ] Execute one supervised smoke flow (open POS, search item, open checkout drawer, cancel safely).
- [ ] Record station name, install time, artifact version, and installer owner in deployment log.

#### 3.2.2 Register #1 Windows install checklist

- [ ] Confirm this PC is **Register #1**, not the server/host role.
- [ ] Confirm **`VITE_API_BASE`** points at the Backoffice / Server PC or production HTTPS origin.
- [ ] Sign in with a cashier/manager and open **Register #1**.
- [ ] Confirm scanner input reaches product search.
- [ ] Confirm receipt-printer settings are station-local and correct.
- [ ] Complete one supervised low-risk sale or test transaction path according to store policy.
- [ ] Confirm receipt success or the documented recovery path.
- [ ] Confirm Register #1 can Z-close the till group and that staff understand Register #2+ are satellite lanes.

#### 3.2.3 Backoffice Windows app install checklist

- [ ] Confirm whether this PC is the **Backoffice / Server PC** or only a client workstation.
- [ ] If it is a client workstation, do not start **Shop Host** there.
- [ ] Confirm staff sign-in, Customers, Orders, Inventory, Reports, and Settings load against the intended API.
- [ ] Confirm any local printer/scanner needs are configured for that station.
- [ ] Confirm About this build reports the expected app version and API base.

### 3.3 PWA (iPad, phones, optional browser-only PCs)

1. Copy [`client/.env.pwa.example`](../client/.env.pwa.example) to **`client/.env.pwa`**.
2. Set **`VITE_API_BASE`** to the **exact origin** those devices use (Tailscale MagicDNS name, HTTPS hostname, etc.). Mismatched origins break API calls and CORS expectations.
3. From **`client/`**: `npm run build:pwa`.
4. Deploy the resulting assets so they are served with the API (Axum static) or from your CDN, consistently with your TLS strategy.

**Version visibility:** Settings → **Updates** shows the single Riverside release version and flags **Update incomplete** when the Windows app, server API, or PWA/web files are out of sync. Settings → General → **About this build** keeps diagnostic build/API details.

**Quality gates:** See section G in [`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) (Playwright, soak, backup drill).

#### 3.3.1 PWA station install checklist (per iPad/phone)

- [ ] Open deployed app URL in Safari/Chrome and confirm TLS is valid.
- [ ] Add to Home Screen and launch from icon (not only browser tab).
- [ ] On Windows laptops or supported mobile browsers, validate Riverside's in-app **Install app** prompt if the surface is meant to stay browser-based instead of Tauri.
- [ ] Verify staff sign-in and shell navigation render correctly.
- [ ] Verify the top bar does not force horizontal scrolling on iPhone-class widths and that status chips remain readable on both phone and iPad.
- [ ] Verify camera/scanner workflow used by that station profile (if applicable).
- [ ] Verify session behavior on shared device (log out / close register when unattended).
- [ ] Verify offline banner copy is understandable: only completed POS checkouts queue; inventory and most back-office actions still need connectivity.
- [ ] Validate stale-cache recovery procedure (hard refresh / clear site data / reinstall icon).
- [ ] Record device name, OS version, browser engine, and test result in deployment log.

#### 3.3.1a Local iPad smoke (same-network PWA)

- [ ] Confirm the iPad is on the same local network as the dedicated **HOST machine**.
- [ ] Open the **local satellite URL** shown by the host panel, not the Tailscale remote path.
- [ ] Add to Home Screen and launch from the iPad icon.
- [ ] Verify tablet shell flow stays comfortable: menu button visible, search bar visible, and status pills readable.
- [ ] Verify one real operator path relevant to that lane profile (for example customer search, order lookup, or assisted register handoff).
- [ ] If the lane uses barcode scanning, verify the paired scanner/HID flow on the iPad specifically.
- [ ] If a receipt is needed, confirm staff understand whether this iPad lane uses server-side network receipt printing or reprints from Register #1.

#### 3.3.1a.1 Register #2 iPad PWA install checklist

- [ ] Confirm Register #1 is open before using the iPad as Register #2.
- [ ] Launch Riverside from the installed Home Screen icon.
- [ ] Sign in with staff PIN and attach/open the satellite register lane.
- [ ] Verify customer lookup, item lookup, cart, and checkout drawer fit comfortably on iPad.
- [ ] Verify paired Bluetooth scanner behaves as keyboard input if this lane scans items.
- [ ] Complete a supervised low-risk register path according to store policy.
- [ ] Confirm staff know printed receipts should be handled by the validated receipt path for that lane, with Register #1 reprint as the recovery path.

#### 3.3.1b Local phone smoke (same-network PWA)

- [ ] Confirm the phone is on the same local network as the dedicated **HOST machine**.
- [ ] Open the **local satellite URL** shown by the host panel, not the Tailscale remote path.
- [ ] Add to Home Screen where appropriate and relaunch from the installed icon.
- [ ] Verify phone shell flow is usable: menu button visible, universal search visible, no horizontal overflow, and offline/pending-sync pills readable.
- [ ] Verify one phone-relevant task such as quick customer lookup, order lookup, or shipment status access.
- [ ] Validate stale-cache recovery on phone: close/reopen icon, then clear site data or reinstall only if still stale.

#### 3.3.1d Windows laptop PWA install checklist

- [ ] Open the production/local Riverside URL in Edge or Chrome.
- [ ] Use the browser **Install app** action when available.
- [ ] Launch from the installed app icon and confirm it opens standalone.
- [ ] Confirm staff sign-in, Back Office navigation, and POS navigation if this laptop is allowed to use POS.
- [ ] Confirm the laptop is using the intended path:
  - same-network store laptop: local host URL
  - off-site laptop: Tailscale remote path
- [ ] Confirm no horizontal scrolling appears in core Back Office/POS workflows at the laptop's normal resolution.

#### 3.3.1c Remote PWA smoke (off-site over Tailscale)

- [ ] Confirm the remote device is **not** on the store LAN and is using **Tailscale** intentionally.
- [ ] Confirm both the host machine and the remote device are connected to the same Tailscale network.
- [ ] Open the store's **remote Tailscale path**, not the local host URL.
- [ ] Verify sign-in works and staff roster/API data are coming from the correct store.
- [ ] Verify one read-heavy remote task such as customer search, order lookup, or shipment lookup.
- [ ] Verify operators understand remote access is separate from in-store local access and should not be handed out as a generic local onboarding URL.

#### 3.3.2 Dedicated host smoke check (required when using Shop Host)

- [ ] On the dedicated host machine, open **Settings → Remote Access** and start **Shop Host**.
- [ ] Confirm the panel shows **running**, the bind address, and the resolved frontend bundle path.
- [ ] Confirm the panel shows at least one **local satellite URL** based on the host machine's LAN address or host name.
- [ ] On a second iPad or phone that is on the same local network, open that local satellite URL and confirm the Riverside sign-in gate loads.
- [ ] If off-site remote access is enabled, confirm the separate **Tailscale remote path** too.
- [ ] Record which device was used for the same-network smoke and which device was used for the off-site remote smoke.

---

## 4. Environment and security

Key variables (full table in [`DEVELOPER.md`](../DEVELOPER.md)):

| Variable | Purpose |
|----------|---------|
| **`DATABASE_URL`** | PostgreSQL connection string (server only). |
| **`RIVERSIDE_MEILISEARCH_URL`** | Windows Main Hub default: `http://127.0.0.1:7700`. The installer writes this and starts the local Meilisearch task. Docker/local-dev may use `http://meilisearch:7700`. |
| **`RIVERSIDE_MEILISEARCH_API_KEY`** | Windows Main Hub default: `dev_master_key_change_me`. The saved encrypted key in **Settings → Integrations → Meilisearch** must match the running Meilisearch `MEILI_MASTER_KEY`; the env value is the deployment fallback when no saved value exists. |
| **`RIVERSIDE_CORS_ORIGINS`** | Required for browser-facing production when paired with **`RIVERSIDE_STRICT_PRODUCTION=true`**. Comma-separated **browser** origins (e.g. `https://app.example.com,http://192.168.1.50:3000`). |
| **`RIVERSIDE_STRICT_PRODUCTION`** | Recommended production hardening switch. Refuses startup without **`RIVERSIDE_CORS_ORIGINS`**, **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`**, and a valid **`FRONTEND_DIST`**. |
| **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`** | Required if the online store/customer-account routes are reachable. Use a long random secret; never rely on the development fallback in production. |
| **`FRONTEND_DIST`** | Explicit absolute or service-stable path to the deployed `client/dist` bundle. Recommended for production services to avoid cwd-dependent static serving. |
| **`RIVERSIDE_HTTP_BIND`** | Optional bind address (e.g. `127.0.0.1:3000` behind a reverse proxy). |
| **`RIVERSIDE_MAX_BODY_BYTES`** | Optional; raise if large catalog imports fail. |
| **`OTEL_EXPORTER_OTLP_ENDPOINT`**, **`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`**, **`RIVERSIDE_OTEL_ENABLED`**, **`OTEL_SERVICE_NAME`**, **`OTEL_EXPORTER_OTLP_PROTOCOL`** | Optional; **OpenTelemetry OTLP** trace export from the API — full matrix in [`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md) and [`server/.env.example`](../server/.env.example). |
| **Visual Crossing API key** | Configure in **Settings → Integrations → Weather**. See [`WEATHER_VISUAL_CROSSING.md`](WEATHER_VISUAL_CROSSING.md). |
| **`RIVERSIDE_VISUAL_CROSSING_ENABLED`** | Optional; force live weather on/off. See [`WEATHER_VISUAL_CROSSING.md`](WEATHER_VISUAL_CROSSING.md). |

**Secrets** (Helcim, QBO, sync tokens, Visual Crossing, Geoapify, Shippo, Podium, Meilisearch) are saved in Backoffice Settings through encrypted integration credentials; deployment still owns the root encryption key (`RIVERSIDE_CREDENTIALS_KEY`) and non-UI runtime flags. The client bundle only exposes **`VITE_*`**: **`VITE_API_BASE`**. If the UI and API are on the same origin you may intentionally leave `VITE_API_BASE` unset for browser/PWA builds; otherwise set it explicitly per build. Optional: **`VITE_STOREFRONT_EMBEDS`** (Podium widget on public builds — [`PLAN_PODIUM_SMS_INTEGRATION.md`](PLAN_PODIUM_SMS_INTEGRATION.md)), **`VITE_GRAPESJS_STUDIO_LICENSE_KEY`** (GrapesJS Studio in **Settings → Online store** on non-localhost — [`ONLINE_STORE.md`](ONLINE_STORE.md)).

**Release posture:** for production browser deployments, pair **`RIVERSIDE_STRICT_PRODUCTION=true`** with an explicit **`FRONTEND_DIST`** and exact **`RIVERSIDE_CORS_ORIGINS`** values before opening the store.

**Observability:** the API logs with **`tracing`** (`RUST_LOG`) and can send **OpenTelemetry OTLP** traces to your collector when **`OTEL_*`** / **`RIVERSIDE_OTEL_ENABLED`** are set — [`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md). That pipeline is separate from optional browser **Sentry** on in-app bug reports (**`docs/PLAN_BUG_REPORTS.md`**).

**Network**

- **Windows Firewall** on the server PC: allow inbound **TCP 3000** (or your chosen port) from **trusted subnets** (LAN, Tailscale interface), not from the entire internet.
- **HTTPS** for production PWA access; follow [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) (Tailscale Serve, reverse proxy, etc.).

**Counterpoint bridge** (if used): set `ROS_BASE_URL` to the same base URL browsers use; bridge must reach the API ([`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md)).

---

## 5. Per-station configuration (in-app)

### Printers & Scanners

**Settings → Printers & Scanners** stores station-local values in the browser/WebView profile:

- Receipt printer: **`ros.hardware.printer.receipt.mode`**, **`.systemName`**, **`.ip`**, **`.port`**.
- Tag printer: **`ros.hardware.printer.tag.mode`**, **`.systemName`**, **`.ip`**.
- Report printer: **`ros.hardware.printer.report.mode`**, **`.systemName`**, **`.ip`**.

**Paths**

- **Tauri:** thermal payloads are sent either to the selected **installed Windows printer** or with **native TCP** from the PC (`printerBridge` → Tauri `invoke` → `client/src-tauri/src/hardware.rs`).
- **Browser / PWA:** the same module can call **`POST /api/hardware/print`** so the **server** opens TCP to the printer IP (printer must be reachable **from the server** on the network).

Configure each **Register 1** PC with either the installed **Epson TM-m30III receipt printer** selected by name or the Epson printer network address. Preferred setup for Register #1 receipts is **Network address** with a static/DHCP-reserved Epson IP because it keeps ESC/POS receipts and cash drawer kick on the direct receipt-printer path. Use **Installed printer on this PC** for USB printers, report/label printers that rely on Windows driver sizing, or as a fallback if raw network printing is not available.

Configure the **Tag Station** to the installed Windows printer queue for the LP 2844 on the Main Hub / tag-printing PC, normally **Zebra LP 2844**. Riverside clothing tags use **EPL2 only**; do not configure ZPL, auto-detect, or another Zebra model for tag sign-off.

### 5.1 Station commissioning checklist (go-live required)

Run this on every station before first customer:

- [ ] Staff sign-in works with expected role and permissions.
- [ ] POS navigation opens and register session can be opened/attached correctly.
- [ ] Product search and cart interactions respond with expected performance.
- [ ] Checkout drawer opens and can be dismissed safely.
- [ ] Help drawer opens from station header/top bar.
- [ ] Printers & Scanners values verified and saved.
- [ ] One supervised sample transaction (or safe dry run) completed per station class.
- [ ] Incident/exception notes captured with station ID and owner.

---

## 6. Hardware matrix (reference deployment)

This section matches a common Riverside deployment: **Zebra** scanners and label printer, **Epson** receipt printer, **iPad** second register, and Helcim payment hardware.

| Station | Device | Role in Riverside OS |
|---------|--------|----------------------|
| Register 1 | **Zebra DS2208** | USB **keyboard wedge (HID)**. Focus the POS search / SKU field; scans appear as typed text. No scanner SDK in the app. |
| Register 2 | **Zebra CS6080** | Pair to iPad as a **Bluetooth keyboard (HID)** so Safari receives scan data as keystrokes. Program a **suffix** (Enter/Tab) if your workflow needs automatic submit. |
| Back office | **Zebra LP 2844** | **Shelf / inventory tags:** ROS generates **EPL2** at 203 DPI and sends it to the saved Tag Station target. Browser print preview is not proof that tag printing works. |
| Register 1 | **Epson TM-m30III** (receipts) | Prefer **Network address** with static/DHCP-reserved IP for receipts and cash drawer. Installed-printer mode is available for USB/driver-managed fallback. |
| Register 2 (iPad) | Receipts | See **subsection 6.2** — current app behavior. |
| Register lanes using card present | **Helcim Terminal reader(s)** | Used for card-present checkout flow; must be registered to correct location and validated per-lane before go-live. |

### 6.0 Hardware commissioning checklist (required before go-live)

#### Receipt printers
- [ ] Installed Windows printer selected in ROS, or static/DHCP-reserved IP documented for raw network mode.
- [ ] Reachable from required host (Tauri PC for installed/network desktop print and/or API host for server-side print path).
- [ ] Test receipt printed from ROS flow.
- [ ] Spare paper stock and quick paper-reload SOP verified.

#### Report / label printers
- [ ] Correct Windows/macOS driver installed.
- [ ] Correct page size/media profile configured.
- [ ] Windows printer queue for the LP 2844 exists on the Main Hub / tag-printing PC, and Printers & Scanners has that exact queue selected.
- [ ] **Tag Designer → Print test tag** reaches the Zebra LP 2844 directly using EPL2; preview fallback is documented for outages only.
- [ ] Test report print passes with no scaling/cropping issues.
- [ ] Fallback printer routing documented for busy-day contingencies.

#### Scanners
- [ ] Device paired/connected in HID wedge mode.
- [ ] Scan suffix behavior validated (Enter/Tab as desired).
- [ ] POS search scan test passed.
- [ ] Inventory/search input scan test passed.
- [ ] Battery/charging and spare unit plan documented.

#### Credit-card hardware (Helcim Terminal)
- [ ] Reader firmware and location registration confirmed.
- [ ] Reader visible/healthy in store payment settings.
- [ ] Terminal 1 device code saved in **Settings → Helcim** or `HELCIM_TERMINAL_1_DEVICE_CODE`.
- [ ] Terminal 2 device code saved in **Settings → Helcim** or `HELCIM_TERMINAL_2_DEVICE_CODE`.
- [ ] Optional: Helcim webhook delivery URL configured only if ROS has a public HTTPS API URL: `https://<public-ros-api-host>/api/webhooks/helcim`.
- [ ] Optional: Helcim webhook events enabled: `cardTransaction` and `terminalCancel`.
- [ ] Optional: Helcim webhook signing secret saved in **Settings → Helcim**.
- [ ] Optional: First signed webhook received by ROS verified in **Payments → Health**. Confirm separately whether the provider event attached to a ROS checkout; webhook receipt alone does not prove ROS recorded a payment.
- [ ] Card Reader path validated: ROS sends the amount to the selected terminal and records the approved Helcim attempt.
- [ ] Manual Card / phone-order path validated: ROS sends the amount to the selected terminal and staff key the card on the terminal, not in ROS.
- [ ] Card Refund path validated with an original Helcim transaction id: ROS sends the refund to the selected terminal and records the approved refund as a negative card tender.
- [ ] Saved Card path validated with a customer Helcim vault card: ROS charges the token and stores only safe provider metadata.
- [ ] Reader disconnect/failure fallback procedure trained.
- [ ] Refund/credit reconciliation path verified in reports and logs.

### 6.1 Epson TM-m30III receipt setup

The POS **Sale complete** flow prints the standard Epson receipt as **ESC/POS** through [`client/src/lib/printerBridge.ts`](../client/src/lib/printerBridge.ts). Register #1 can target either:

1. **Network address**: direct Epson printer IP and port, usually **9100**.
2. **Installed printer on this PC**: a locally installed Windows printer selected by name.

**Recommended Register #1 setup:** use **Network address** when the Epson TM-m30III has a static IP or DHCP reservation. This is the simplest path for thermal receipts and the Register #1 cash drawer command. Use **Installed printer on this PC** when the printer is USB-only, Windows driver management is required, or network printing is blocked.

Work with your installer or Epson docs for the TM-m30III static IP/DHCP reservation. Record the chosen mode, printer name or IP, and test receipt result in the deployment log.

### 6.2 iPad Register 2 — physical receipt print

[`ReceiptSummaryModal`](../client/src/components/pos/ReceiptSummaryModal.tsx) uses [`printerBridge`](../client/src/lib/printerBridge.ts) for receipt dispatch. In PWA/browser mode, the receipt can use **server-side network printing** through `POST /api/hardware/print` when the Epson printer IP is reachable from the API host. Installed-printer targets and local readiness checks still require the Riverside desktop app.

**Operational rule:** keep Register #1 Windows Tauri as the primary receipt and cash-drawer station. Use iPad receipt print only after validating the server can reach the Epson network address, and reprint from Register #1 if the PWA/server print path fails.

---

## 7. Operations

- **Applying updates (local / no GitHub):** [`LOCAL_UPDATE_PROTOCOL.md`](LOCAL_UPDATE_PROTOCOL.md) — backup, migrations, server binary + `FRONTEND_DIST`, Tauri and PWA rollout, rollback.
- **Backups and restore:** [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md).
- **Offline behavior:** POS may **queue checkouts** offline; back-office and inventory mutations generally require the API ([`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) section F).
- **Large catalogs:** customer browse and inventory lists use paging; spot-check latency on Wi-Fi and Tailscale before busy weekends ([`docs/SEARCH_AND_PAGINATION.md`](SEARCH_AND_PAGINATION.md)).

### 7.1 Troubleshooting (short)

### 7.1.1 Shop Host is running but satellites still cannot connect

1. Confirm the satellite device is on the same local network as the dedicated host machine.
2. Use the **local satellite URL** shown in the host panel first; do not substitute the Tailscale address for in-store devices.
3. If more than one local path is shown, try the detected **LAN IPv4** first.
4. If the host panel cannot detect a LAN address, verify the host machine's local network connection before store open.

### 7.1.2 Remote PWA works but local in-store PWA does not

1. Confirm the in-store device is using the **local satellite URL**, not the Tailscale remote path.
2. Confirm the device is actually on the same local network as the dedicated host machine.
3. Re-run the host smoke check from **3.3.2** using a second local device before opening the store.

**PWA will not load**

1. From the device browser, open **`VITE_API_BASE`** (same origin the app was built with).
2. Tailscale / DNS: [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md).
3. HTTPS certificate validity and device clock.
4. Hard refresh; clear site data or remove and re-add the home screen icon.
5. Collect **Settings → General → About this build**.

**Desktop register will not print**

1. In **Printers & Scanners**, confirm whether the station uses **Network address** or **Installed printer on this PC**.
2. For network mode, confirm printer **IP**, port, ping from the PC, and Windows Firewall outbound access, often **TCP 9100**.
3. For installed-printer mode, confirm the printer appears in Windows and can print a Windows test page.
4. **Tauri** can use the selected local printer target; **PWA** print fallback uses **`/api/hardware/print`** and requires the server to reach the network printer.
5. Restart the desktop app after printer or network changes.

**Shelf labels (LP 2844)**

1. Confirm Windows shows the installed LP 2844 printer queue and that Riverside has that exact queue selected.
2. Retry from the inventory tag workflow. Direct label dispatch should print without a system dialog and should use EPL2.
3. If direct dispatch is unavailable, fix the Windows queue/driver/media size before treating tag printing as ready.

---

## 8. Related documentation

- [`DEPLOYMENT_MANAGER.md`](DEPLOYMENT_MANAGER.md) — Graphical Deployment Manager, audits, resets, and credential logic.
- [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) — Tailscale, phones, laptops.
- [`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) — PWA vs Tauri builds, CORS, offline, QA sign-off.
- [`docs/RELEASE_QA_CHECKLIST.md`](RELEASE_QA_CHECKLIST.md) — release validation gates, E2E policy, canonical visual workflow.
- [`docs/ORBSTACK_GUIDE.md`](ORBSTACK_GUIDE.md) — macOS Docker runtime standard and verification.
- [`DEVELOPER.md`](../DEVELOPER.md) — local dev, env vars, architecture.
- [`docs/STAFF_PERMISSIONS.md`](STAFF_PERMISSIONS.md) — RBAC, headers, PINs.
- [`docs/TILL_GROUP_AND_REGISTER_OPEN.md`](TILL_GROUP_AND_REGISTER_OPEN.md) — multi-lane register, combined Z-close.
- [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md) — database maintenance and cloud sync.
- [`INVENTORY_GUIDE.md`](../INVENTORY_GUIDE.md) — scanning and physical inventory behavior.
- [`AGENTS.md`](../AGENTS.md) — repo map and invariants for contributors.

---

*Last aligned with application behavior as of repository documentation practices; verify receipt and print flows against your installed version using **About this build**.*
