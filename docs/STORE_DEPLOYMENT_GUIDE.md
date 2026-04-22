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
- `docker compose ps` should show expected services healthy (`db`, optional `meilisearch`, optional `metabase` stack).

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

**Optional Meilisearch:** Many shops run a small **Meilisearch** process on the same server PC (or another host on the LAN) for fuzzy inventory, CRM, wedding, order, and storefront PLP search. PostgreSQL remains authoritative; the API syncs index documents and falls back to SQL **ILIKE** if Meilisearch is down. After deploy or restore, admins run **Settings → Integrations → Meilisearch → Rebuild search index** (or **`POST /api/settings/meilisearch/reindex`**). Details: [`SEARCH_AND_PAGINATION.md`](SEARCH_AND_PAGINATION.md).

---

## 2. Roles and recommended client

| Role | Recommended client | Notes |
|------|-------------------|--------|
| **Host machine** | Windows PC running services | Run PostgreSQL and `riverside-server` here. If you use Shop Host, this is the one Tauri machine that should serve local-network satellite clients. This PC should stay on and be on UPS if possible. |
| **Main Register** | **Tauri (Windows)** | Separate from the host machine. This is the primary cashier station and the preferred surface for **physical receipt print** from the post-sale flow (see section 6). |
| **Back office workstation** | Browser or optional Tauri | Same API origin and auth model; optional Tauri if you want a dedicated shell. |
| **Local iPad / phone satellites** | **PWA** | Use Add to Home Screen and point to the host machine while on the same local network. Shared device: **log out or close the register** when unattended ([`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md)). |
| **Off-site phones / laptops** | **PWA over Tailscale** | Use **Tailscale** (or equivalent private mesh) and **HTTPS** when the device is not on the same local network as the host. Do not expose plain HTTP to the public internet for staff apps ([`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md)). |

### Till shift: Register #1 and satellite lanes

The app supports **multiple open register terminals** (migration **66**) sharing one **till close group** (**67**): **Register #1** is the **cash drawer** (opening float, paid in/out, **Z-close**). **Register #2+** link to an open **#1** session (**$0** satellite float); **Z** on **#1** closes **all** lanes in the group. Train staff that **physical cash** for the day lives in the **#1** drawer even when tenders post from **#2**. Full behavior: **[`docs/TILL_GROUP_AND_REGISTER_OPEN.md`](TILL_GROUP_AND_REGISTER_OPEN.md)**.

---

## 3. Build and release artifacts

### 3.1 Server (shop server PC)

- **Rust binary** for the API (`cargo build --release` in `server/`, or your CI artifact). The server pins **Rust 1.88+** in **`server/rust-toolchain.toml`** (**`ort`** / **fastembed** for staff-help embeddings); use that toolchain in CI and release builds.
- **Production web bundle** `client/dist` copied next to the deployment layout your runbook uses (Axum serves this folder in production).
- **Database**: PostgreSQL reachable via **`DATABASE_URL`**. Apply all migrations in `migrations/` in order (see [`DEVELOPER.md`](../DEVELOPER.md)). If you ship ROS-AI help, set **`RIVERSIDE_REPO_ROOT`** to the deployed tree that contains **`docs/staff/CORPUS.manifest.json`** and run **`POST /api/ai/admin/reindex-docs`** after upgrades that change staff docs — [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md).

### 3.2 Windows desktop app (Register 1 + Back office)

1. Copy [`client/.env.register.example`](../client/.env.register.example) to **`client/.env.register`** (gitignored).
2. Set **`VITE_API_BASE`** to the origin **each PC can reach** (LAN IP or hostname of the server, or your HTTPS URL). Avoid `http://127.0.0.1:3000` unless the API truly runs on that same machine.
3. From **`client/`**: `npm run tauri:build` (runs the register build first per Tauri config).

Installer signing and CI notes: [`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) section D.

#### 3.2.1 Tauri station install checklist (per Windows station)

- [ ] Confirm Windows user account and local admin rights for install/update.
- [ ] Install the correct Riverside desktop artifact for the release version.
- [ ] Launch app and verify **Settings → General → About this build** shows expected app version + API base.
- [ ] Confirm station reaches API origin and can sign in with staff PIN flow.
- [ ] Confirm station-specific Printing Hub values are set (receipt/report destinations).
- [ ] Confirm scanner input reaches focused fields as keyboard wedge text.
- [ ] Execute one supervised smoke flow (open POS, search item, open checkout drawer, cancel safely).
- [ ] Record station name, install time, artifact version, and installer owner in deployment log.

### 3.3 PWA (iPad, phones, optional browser-only PCs)

1. Copy [`client/.env.pwa.example`](../client/.env.pwa.example) to **`client/.env.pwa`**.
2. Set **`VITE_API_BASE`** to the **exact origin** those devices use (Tailscale MagicDNS name, HTTPS hostname, etc.). Mismatched origins break API calls and CORS expectations.
3. From **`client/`**: `npm run build:pwa`.
4. Deploy the resulting assets so they are served with the API (Axum static) or from your CDN, consistently with your TLS strategy.

**Version visibility:** Settings → General → **About this build** (semver, git SHA, Tauri version on desktop, API base).

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
- [ ] If a receipt is needed, confirm staff understand that physical thermal receipt printing still requires a Windows Tauri station today.

#### 3.3.1b Local phone smoke (same-network PWA)

- [ ] Confirm the phone is on the same local network as the dedicated **HOST machine**.
- [ ] Open the **local satellite URL** shown by the host panel, not the Tailscale remote path.
- [ ] Add to Home Screen where appropriate and relaunch from the installed icon.
- [ ] Verify phone shell flow is usable: menu button visible, universal search visible, no horizontal overflow, and offline/pending-sync pills readable.
- [ ] Verify one phone-relevant task such as quick customer lookup, order lookup, or shipment status access.
- [ ] Validate stale-cache recovery on phone: close/reopen icon, then clear site data or reinstall only if still stale.

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
| **`RIVERSIDE_MEILISEARCH_URL`** | Optional; e.g. `http://127.0.0.1:7700` (host) or `http://meilisearch:7700` (same Docker network as the API). When unset, all search paths use SQL **ILIKE** only. |
| **`RIVERSIDE_MEILISEARCH_API_KEY`** | Optional; Meilisearch **master** or **API key** with index access. Store in secrets; never log. |
| **`RIVERSIDE_CORS_ORIGINS`** | Required for browser-facing production when paired with **`RIVERSIDE_STRICT_PRODUCTION=true`**. Comma-separated **browser** origins (e.g. `https://app.example.com,http://192.168.1.50:3000`). |
| **`RIVERSIDE_STRICT_PRODUCTION`** | Recommended production hardening switch. Refuses startup without **`RIVERSIDE_CORS_ORIGINS`**, **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`**, and a valid **`FRONTEND_DIST`**. |
| **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`** | Required if the online store/customer-account routes are reachable. Use a long random secret; never rely on the development fallback in production. |
| **`FRONTEND_DIST`** | Explicit absolute or service-stable path to the deployed `client/dist` bundle. Recommended for production services to avoid cwd-dependent static serving. |
| **`RIVERSIDE_HTTP_BIND`** | Optional bind address (e.g. `127.0.0.1:3000` behind a reverse proxy). |
| **`RIVERSIDE_MAX_BODY_BYTES`** | Optional; raise if large catalog imports fail. |
| **`OTEL_EXPORTER_OTLP_ENDPOINT`**, **`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`**, **`RIVERSIDE_OTEL_ENABLED`**, **`OTEL_SERVICE_NAME`**, **`OTEL_EXPORTER_OTLP_PROTOCOL`** | Optional; **OpenTelemetry OTLP** trace export from the API — full matrix in [`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md) and [`server/.env.example`](../server/.env.example). |
| **`RIVERSIDE_VISUAL_CROSSING_API_KEY`** | Optional; server-side Visual Crossing key (overrides DB `weather_config`). See [`WEATHER_VISUAL_CROSSING.md`](WEATHER_VISUAL_CROSSING.md). Never expose to the client. |
| **`RIVERSIDE_VISUAL_CROSSING_ENABLED`** | Optional; force live weather on/off. See [`WEATHER_VISUAL_CROSSING.md`](WEATHER_VISUAL_CROSSING.md). |

**Secrets** (Stripe, QBO, sync tokens, Visual Crossing key, storefront JWT secret) stay **server-side**. The client bundle only exposes **`VITE_*`**: **`VITE_API_BASE`**. If the UI and API are on the same origin you may intentionally leave `VITE_API_BASE` unset for browser/PWA builds; otherwise set it explicitly per build. Optional: **`VITE_STOREFRONT_EMBEDS`** (Podium widget on public builds — [`PLAN_PODIUM_SMS_INTEGRATION.md`](PLAN_PODIUM_SMS_INTEGRATION.md)), **`VITE_GRAPESJS_STUDIO_LICENSE_KEY`** (GrapesJS Studio in **Settings → Online store** on non-localhost — [`ONLINE_STORE.md`](ONLINE_STORE.md)).

**Release posture:** for production browser deployments, pair **`RIVERSIDE_STRICT_PRODUCTION=true`** with an explicit **`FRONTEND_DIST`** and exact **`RIVERSIDE_CORS_ORIGINS`** values before opening the store.

**Observability:** the API logs with **`tracing`** (`RUST_LOG`) and can send **OpenTelemetry OTLP** traces to your collector when **`OTEL_*`** / **`RIVERSIDE_OTEL_ENABLED`** are set — [`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md). That pipeline is separate from optional browser **Sentry** on in-app bug reports (**`docs/PLAN_BUG_REPORTS.md`**).

**Network**

- **Windows Firewall** on the server PC: allow inbound **TCP 3000** (or your chosen port) from **trusted subnets** (LAN, Tailscale interface), not from the entire internet.
- **HTTPS** for production PWA access; follow [`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md) (Tailscale Serve, reverse proxy, etc.).

**Counterpoint bridge** (if used): set `ROS_BASE_URL` to the same base URL browsers use; bridge must reach the API ([`REMOTE_ACCESS_GUIDE.md`](../REMOTE_ACCESS_GUIDE.md)).

---

## 5. Per-station configuration (in-app)

### Printing Hub

**Settings → Printing Hub** stores station-local values in the browser/WebView profile:

- Receipt printer: **`ros.pos.printerIp`**, **`ros.pos.printerPort`** (default port **9100** for raw network printers).
- Report printer: **`ros.report.printerIp`** (and related keys as shown in Settings).

**Paths**

- **Tauri:** thermal payloads are sent with **native TCP** from the PC (`printerBridge` → Tauri `invoke` → `client/src-tauri/src/hardware.rs`).
- **Browser / PWA:** the same module can call **`POST /api/hardware/print`** so the **server** opens TCP to the printer IP (printer must be reachable **from the server** on the network).

Configure each **Register 1** PC with the **Epson receipt printer IP** (or your chosen workflow; see hardware section below).

### 5.1 Station commissioning checklist (go-live required)

Run this on every station before first customer:

- [ ] Staff sign-in works with expected role and permissions.
- [ ] POS navigation opens and register session can be opened/attached correctly.
- [ ] Product search and cart interactions respond with expected performance.
- [ ] Checkout drawer opens and can be dismissed safely.
- [ ] Help drawer opens from station header/top bar.
- [ ] Printing Hub values verified and saved.
- [ ] One supervised sample transaction (or safe dry run) completed per station class.
- [ ] Incident/exception notes captured with station ID and owner.

---

## 6. Hardware matrix (reference deployment)

This section matches a common Riverside deployment: **Zebra** scanners and label printer, **Epson** receipt printer, **iPad** second register, and Stripe payment hardware.

| Station | Device | Role in Riverside OS |
|---------|--------|----------------------|
| Register 1 | **Zebra DS2208** | USB **keyboard wedge (HID)**. Focus the POS search / SKU field; scans appear as typed text. No scanner SDK in the app. |
| Register 2 | **Zebra CS6080** | Pair to iPad as a **Bluetooth keyboard (HID)** so Safari receives scan data as keystrokes. Program a **suffix** (Enter/Tab) if your workflow needs automatic submit. |
| Back office | **Zebra LP 2844** | **Shelf / inventory labels:** the app opens a **print layout** and uses the **system print dialog** (`labelPrint.ts`, `@page` **4in × 2.5in**). Install the **Zebra Windows driver**, match **label stock** and driver page size to avoid scaling issues. Tauri and Edge use the same OS print path for this feature. |
| Register 1 | **Epson TM-m30III** (receipts) | See **subsection 6.1** — important language/protocol note. |
| Register 2 (iPad) | Receipts | See **subsection 6.2** — current app behavior. |
| Register lanes using card present | **Stripe Terminal reader(s)** | Used for card-present checkout flow; must be registered to correct location and validated per-lane before go-live. |

### 6.0 Hardware commissioning checklist (required before go-live)

#### Receipt printers
- [ ] Static/DHCP-reserved IP documented.
- [ ] Reachable from required host (Tauri PC and/or API host for server-side print path).
- [ ] Test receipt printed from ROS flow.
- [ ] Spare paper stock and quick paper-reload SOP verified.

#### Report / label printers
- [ ] Correct Windows/macOS driver installed.
- [ ] Correct page size/media profile configured.
- [ ] Test print from report/label workflow passes with no scaling/cropping issues.
- [ ] Fallback printer routing documented for busy-day contingencies.

#### Scanners
- [ ] Device paired/connected in HID wedge mode.
- [ ] Scan suffix behavior validated (Enter/Tab as desired).
- [ ] POS search scan test passed.
- [ ] Inventory/search input scan test passed.
- [ ] Battery/charging and spare unit plan documented.

#### Credit-card hardware (Stripe Terminal)
- [ ] Reader firmware and location registration confirmed.
- [ ] Reader visible/healthy in store payment settings.
- [ ] Card-present payment intent path validated with supervised test.
- [ ] Reader disconnect/failure fallback procedure trained.
- [ ] Refund/credit reconciliation path verified in reports and logs.

### 6.1 Epson TM-m30III and ZPL (read carefully)

Today, the POS **Sale complete** flow loads **`GET /api/orders/{order_id}/receipt.zpl`** and sends the response as **ZPL** over **TCP** (default port **9100**) via **`printZplReceipt`** in [`client/src/lib/printerBridge.ts`](../client/src/lib/printerBridge.ts).

**ZPL is Zebra’s wire format.** The **Epson TM-m30III** expects **ESC/POS** (or driver-mediated printing), **not ZPL**, on a **raw** socket. Pointing the current ZPL job at the Epson’s raw **9100** port will **not** produce a correct receipt.

**Practical options (operations):**

1. **Use a Zebra-class (ZPL-capable) network receipt printer** on raw **IP:9100** if you need the current pipeline without code changes.
2. Use **Epson driver- or ePOS-based printing** outside the current raw-ZPL path (not exposed as a first-class alternate in the receipt modal today).
3. **Engineering follow-up:** add an **ESC/POS** receipt generator and client selection (separate project from this guide).

Work with your installer or Epson docs for **static IP** or **DHCP reservation** for the TM-m30III if you move to a supported print path later.

### 6.2 iPad Register 2 — physical receipt print

[`ReceiptSummaryModal`](../client/src/components/pos/ReceiptSummaryModal.tsx) **requires Tauri** for the Print action: if `isTauri()` is false, it shows an error that **physical printing requires the Riverside OS desktop app**.

So **iPad PWA cannot print a thermal receipt from that button today**, even though `printerBridge` could theoretically use **server-side** print for non-Tauri clients.

**Operational workarounds:** complete the sale on iPad, then **reprint from Register 1** or another **Windows Tauri** station; or treat printed customer copy as optional on that lane until product supports PWA/server receipt dispatch.

---

## 7. Operations

- **Applying updates (local / no GitHub):** [`docs/LOCAL_UPDATE_PROTOCOL.md`](LOCAL_UPDATE_PROTOCOL.md) — backup, migrations, server binary + `FRONTEND_DIST`, Tauri and PWA rollout, rollback.
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

1. Confirm printer **IP** and **ping** from the PC.
2. Windows Firewall: **outbound** to printer (often **TCP 9100**).
3. **Tauri** path uses local TCP; **PWA** path uses **`/api/hardware/print`** (server must reach the printer).
4. Restart the desktop app after network changes.

**Shelf labels (LP 2844)**

1. Confirm the **LP 2844** is the selected printer in the system dialog.
2. Driver label size vs **4in × 2.5in** layout in the app.

---

## 8. Related documentation

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
