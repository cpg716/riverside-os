# Riverside OS — Local update protocol (offline / no GitHub)

Canonical runbook for moving a **single store** from **version A → version B** when you **do not** use GitHub (or any hosted CI). Artifacts are built on a developer machine and delivered via **LAN push, USB drive, SMB share, zip**, or equivalent.

Deeper context: initial deployment topology and builds — [`STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md). Database backup and restore — [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md). PWA vs Tauri behavior — [`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md).

---

## 1. Scope

- **One** PostgreSQL database and **one** API host (typical: Windows PC running Postgres + `riverside-server`), as in the store deployment guide.
- **No** requirement for git remotes or GitHub Actions. If you keep `.github/workflows/` in the repo, treat it as optional; your **release machine** is whatever builds `cargo build --release`, `npm run build` / `npm run build:pwa` / `npm run tauri:build`.

```mermaid
flowchart LR
  Backup[Backup]
  Stop[Stop API]
  Migrate[Migrate DB]
  Deploy[Deploy binary and dist]
  Start[Start API]
  Clients[Client rollout]
  Backup --> Stop --> Migrate --> Deploy --> Start --> Clients
```

---

## 2. Release bundle contents

Ship a folder or archive the operator can keep on the server PC (or copy from media). Minimum checklist:

| Item | Notes |
|------|--------|
| **Server binary** | From `server/`: `cargo build --release` (artifact name/platform as built, e.g. `riverside-server.exe` or `riverside-server`). |
| **Web UI static files** | `client/dist/**` from `npm run build` (or `npm run build:pwa` if that is what you serve in production — match how you built last time). |
| **SQL migrations and seeds** | Full active `migrations/` baseline plus the approved `scripts/seeds/` files for the target environment. |
| **Release notes** | Short text: version label, **new or changed environment variables** (see [`DEVELOPER.md`](../DEVELOPER.md)), any one-time operator steps. Compare with `server/.env.example` on the release branch. |

**Naming (recommended):** `riverside-os-YYYY-MM-DD-vX.Y.Z.zip` (or folder) so support can match **Settings → General → About this build** with a physical artifact.

---

## 3. Version record (before and after)

1. In the app (any station): **Settings → General → About this build** — note **semver**, **git SHA**, and **API base**.
2. On the server: note binary file modified time or your own version label.
3. After update: repeat and **log** old → new in your internal maintenance log.

---

## 4. Pre-update checklist

- [ ] **Window:** Pick a low-traffic time; tell staff the API will be unavailable briefly.
- [ ] **Registers:** Avoid closing desktop apps **during** a pending offline checkout sync (see offline notes in [`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) section F). Brief downtime is normal; communication reduces surprise.
- [ ] **Access:** Operator has OS access to the server PC, Postgres credentials (or `DATABASE_URL`), and the folder where the server binary and `FRONTEND_DIST` live.
- [ ] **Release bundle** on hand and verified (not zero-byte copy).

---

## 5. Server PC procedure

> **As of v0.80.9, the recommended path for all routine updates is the in-app updater.** The manual steps below (5.2–5.7) are the fallback for offline environments or when the in-app updater is not available.

### 5.0 Push to Main Hub (recommended for same-network hotfixes)

When the production Main Hub is reachable on the same network, use the guarded LAN push workflow instead of waiting for GitHub release assets. The default fast path is **client-only**: the Mac sends the committed source snapshot to the Main Hub, the Main Hub builds the web bundle, and the script atomically swaps `C:\RiversideOS\client\dist` without rebuilding the Rust server binary, running migrations, or repackaging installer assets.

Prerequisites:

- PowerShell Remoting is enabled on the Main Hub.
- The account used for the remote session is a local Administrator on the Main Hub.
- The Main Hub has its installed config at `C:\RiversideOS\riverside-deployment.config.json`.

If PowerShell Remoting has not been enabled yet, run this once from an elevated PowerShell window on the Main Hub:

```powershell
.\deployment\windows\Enable-MainHubLanAdmin.ps1 -MacClientCompatibility -Force
```

For normal UI/web-only LAN updates, run from the repo root:

```bash
ROS_MAIN_HUB_HOST="MAIN-HUB-NAME-OR-IP" npm run push:main-hub:fast
```

From macOS, pass a Windows administrator identity explicitly:

```bash
ROS_MAIN_HUB_HOST="MAIN-HUB-NAME-OR-IP" \
ROS_MAIN_HUB_USER="MAIN-HUB-NAME-OR-IP\\Admin" \
npm run push:main-hub:fast
```

The script will prompt for the password if `ROS_MAIN_HUB_PASSWORD` is not set.
For the private-LAN macOS-to-Windows setup, add `-- -Authentication Basic` when using npm script arguments.

The client-only path may install or require Node.js via Windows Package Manager. It writes `C:\RiversideOS\lan-update-summary.json` and verifies the existing server health endpoint after the static bundle swap.

Use the full source-build mode only when the server binary must change and no prebuilt GitHub/Main Hub update package is available:

```bash
ROS_MAIN_HUB_HOST="MAIN-HUB-NAME-OR-IP" npm run push:main-hub:fast -- -Mode Full
```

Full mode may install or require Rust and can take substantially longer on the Main Hub. For routine backend/server changes, prefer the GitHub `main-hub-update` or `full-deployment` package path and push that package over LAN with `npm run push:main-hub`.

If you already have a prebuilt package, use the package push path instead:

```bash
ROS_MAIN_HUB_HOST="MAIN-HUB-NAME-OR-IP" npm run push:main-hub
```

Or pass values explicitly:

```powershell
pwsh -NoProfile -File scripts/push-main-hub.ps1 `
  -MainHubHost "MAIN-HUB-NAME-OR-IP" `
  -PackagePath "dist/deployment/RiversideOS-v0.95.0-<build-sha>-MainHub-Update.zip"
```

The package push script:

1. verifies the local package shape;
2. copies it to `C:\ProgramData\RiversideOS\incoming\<timestamp>` on the Main Hub;
3. creates a pre-update `pg_dump -Fc` backup under `C:\RiversideOS\backups`;
4. runs the packaged `install-server.ps1` with the installed Main Hub config;
5. waits for the existing installer health checks and prints `/api/version`.

Use `-SkipBackup` only when a separate current backup has already been verified. Use `-SkipMigrations`, `-SkipRosieSetup`, or `-NoStart` only for narrow support cases.

### 5.1 In-App Update (GitHub release path — requires internet access)

This is the standard update path for all production stores:

1. **Admin notification**: The server checks GitHub for new releases daily and sends an `update_available` in-app notification to all `settings.admin` staff when a newer version is found.
2. **Timing**: Updates should be performed **before 10 AM or after 6 PM** (outside store hours). The update UI warns if the store may be open.
3. **On the Main Hub (Backoffice / Server PC)**:
   - Open **Settings → Updates → Server update**.
   - Confirm the version banner shows the available update.
   - Click **"Update server to vX.X.X"** and monitor the progress steps.
   - The system automatically: downloads the deployment ZIP, runs `install-server.ps1` + migrations elevated, **restarts the `Riverside OS Server` scheduled task**, and polls `/api/health` until the server is confirmed ready.
   - When the PowerShell window prints "Update Complete", relaunch Riverside on all stations.
4. **On Register / Back Office satellite stations**:
   - The next time staff launch the app, the `BackofficeSignInGate` checks `GET /api/version`.
   - If the server is ahead of the client, the sign-in screen is **replaced with a blocking update prompt**.
   - Windows Tauri stations: click **"Update to vX.X.X"** to pull the signed MSI via the Tauri updater.
   - PWA / browser stations: reload after the server admin has pushed updated web files.
   - Staff cannot sign in until client and server versions match.

### 5.2 Backup (mandatory — in-app and manual paths)

Create a **fresh** database backup before any update.

- **In-app:** Back Office → Settings → Backups → **Create backup**, or `POST /api/settings/backups/create` (see [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md)).
- **Or manual:** `pg_dump` to a dated file on disk.

Confirm the backup file has non-trivial size before continuing.

### 5.3 Stop the API (manual / offline path only)

Stop the Riverside OS HTTP process **cleanly** (no hard kill mid-request if avoidable).

- Close the console window if you run `riverside-server` manually.
- In a production Windows install, stop the `"Riverside OS Server"` scheduled task via Task Scheduler or `Stop-ScheduledTask -TaskName "Riverside OS Server"`.

Until the process is stopped, do not replace the binary or the static `dist` tree.

### 5.4 Apply database migrations (manual / offline path only)

Migration filenames are tracked in **`public.ros_schema_migrations`**. Never skip the ledger inserts.

**Option A — bash + `psql`:**
```bash
export DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"
./scripts/apply-migrations-psql.sh
```

**Option B — manual `psql`:**
1. For each active `migrations/[0-9][0-9]*_*.sql` in sorted order, if not already in `ros_schema_migrations`:
   - `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /path/to/that/file.sql`
   - `INSERT INTO ros_schema_migrations (version) VALUES ('NN_whatever.sql') ON CONFLICT DO NOTHING;`

If any file fails, **stop** and restore from backup — do not start the new server against a half-applied chain.

### 5.5 Deploy binary and static UI (manual / offline path only)

1. Replace the **server executable** with the one from the release bundle.
2. Replace the **contents** of the `FRONTEND_DIST` directory (atomic swap preferred).

### 5.6 Environment variables

Merge any **new** keys from release notes into the server's `.env`. Full reference: [`DEVELOPER.md`](../DEVELOPER.md).

- `DATABASE_URL`
- `RIVERSIDE_CORS_ORIGINS` (production browser allowlist)
- `RIVERSIDE_STRICT_PRODUCTION=true` (recommended)
- `RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`
- `FRONTEND_DIST`
- `RIVERSIDE_HTTP_BIND`
- ROS-AI help RAG: `RIVERSIDE_REPO_ROOT` — [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md)

### 5.7 Start the API (manual / offline path only)

Start `riverside-server` or restart the `"Riverside OS Server"` scheduled task. Confirm it listens on `0.0.0.0:3000` (or your override).

### 5.8 Smoke test

Before announcing “all clear”:

1. Load the app in a browser at your production origin; confirm login.
2. Open **Register** (or Back Office): one read path (e.g. search) and one low-risk write if policy allows.
3. Optional: `SELECT version FROM ros_schema_migrations ORDER BY version;` — rows should match the active migration files you shipped. For deeper drift checks in dev/Docker, see [`scripts/migration-status-docker.sh`](../scripts/migration-status-docker.sh), [`scripts/validate_schema_contract.sh`](../scripts/validate_schema_contract.sh), and [`docs/SCHEMA_CONTRACT_AND_MIGRATIONS.md`](SCHEMA_CONTRACT_AND_MIGRATIONS.md) (adapt queries to your prod DB as needed).
4. If you ship **new or changed** `docs/staff/**` or **`CORPUS.manifest.json`**, run a **staff help reindex** once the API is up (**`settings.admin`**) — [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md).

### 5.9 Post-update smoke matrix (required before all-clear)

Validate each deployment surface against its real role:

1. **Main Hub**
   - Start **Shop Host**.
   - Confirm running state, bind address, frontend bundle, and local satellite URL.
   - Confirm a second same-network device reaches the sign-in gate from that local satellite URL.
2. **Register #1**
   - Launch the Windows Tauri app.
   - Confirm sign-in, register readiness, one sale path, and printer recovery path per the Windows checklist.
3. **Local iPad / phone PWA**
   - Confirm the device is on the same local network as the Main Hub.
   - Confirm it uses the local Main Hub URL, not the Tailscale path.
   - Confirm sign-in and the expected shell/search/status flow for that device class.
4. **Remote PWA over Tailscale**
   - Confirm the device is off-site or off the store LAN.
   - Confirm it reaches Riverside through the Tailscale remote path.
   - Confirm one low-risk remote workflow such as customer search or order lookup.

---

## 6. Workstations (Tauri / desktop)

For role clarity during rollout:

- the **Main Hub** and **Register #1** are different Windows Tauri machines
- only the dedicated Main Hub should be used for **Shop Host**
- updating a register station does not automatically make it the host

### 6.1 Version gate (automatic enforcement — v0.80.9+)

After the Main Hub server is updated, **satellite stations enforce version sync automatically**. On next launch, `BackofficeSignInGate` checks `GET /api/version`:

- If the server is ahead of the client, the PIN screen is **replaced** with a blocking "Update Required" screen.
- **Windows Tauri stations:** A one-click "Update to vX.X.X" button pulls the signed MSI via the Tauri updater and installs it. Relaunch Riverside when prompted.
- **PWA / browser stations:** The screen shows reload instructions. Updated web files are served by the server automatically after the Main Hub update; a hard reload or service worker clear may be needed.
- Staff cannot sign in until the client version matches the server.

### 6.2 Desktop updater pipeline

For recurring Windows station updates via the Tauri updater channel:

1. Run `.github/workflows/windows-deployment-package.yml` after business hours with:
   - GitHub variable: `RIVERSIDE_UPDATER_PUBLIC_KEY`
   - GitHub secret: `TAURI_SIGNING_PRIVATE_KEY` (+ optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
2. Choose the narrowest release scope that matches the change:
   - `app-updater-only` for Register and Back Office desktop app-only updates.
   - `main-hub-update` for Main Hub server/API, web files, migrations, ROSIE runtime assets, and the local desktop app.
   - `full-deployment` only when Deployment Manager, Server Manager, Counterpoint Bridge GUI, or first-install package contents changed.
3. The workflow publishes `latest.json`, updater artifact, `.sig`, and the matching update package to the GitHub release tag.
4. Stations detect the update automatically on launch via the version gate and prompt one-click install.
5. Keep the previous installer available for rollback.

**`VITE_API_BASE`** remains fixed **at build time** — any desktop rebuild must still target the same API origin staff use. See [`STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md) section 3.2.

---

## 7. PWA / tablets / phones

1. Open **Settings → Updates** and use **Check app files**. If Riverside shows the **PWA update prompt**, use **Reload now** when staff can afford a quick refresh.
2. If the device is still using a browser tab instead of an installed PWA, follow the install guidance first: **Install app** where supported, or **Add to Home Screen** on iPad / iPhone.
3. If the UI is wrong or stale: close and reopen the installed icon, then hard refresh, clear site data, or remove and **Add to Home Screen** again if needed — see troubleshooting in [`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) section H and [`STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md) section 7.1.

---

## 8. Rollback

If you must revert after a failed or bad update:

1. **Stop** the API.
2. **Restore** the database from the backup taken in **5.1** (destructive; follow [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md) — all registers closed, no active work).
3. Redeploy the **previous** server binary and **previous** `dist` tree.

**Warning:** Running an **older** binary against a database that already received **new** migrations (without restoring the old DB) is unsupported and may corrupt data or crash. Rollback = **DB restore + matching old binaries/UI**, not “old exe only.”

---

## 9. Related documentation

| Doc | Use |
|-----|-----|
| [`STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md) | First-time production layout, builds, TLS, firewall |
| [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md) | Backup API, restore cautions |
| [`DEVELOPER.md`](../DEVELOPER.md) | Env vars and schema-contract workflow |
| [`README.md`](../README.md) | Dev quick start; Docker migration scripts for local dev |
| [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md) | Staff help RAG reindex after deploy; **`RIVERSIDE_REPO_ROOT`**, embeddings env |
| [`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`](STAFF_TASKS_AND_REGISTER_SHIFT.md) | Register shift primary, staff recurring tasks, RBAC keys |
| [`docs/STAFF_SCHEDULE_AND_CALENDAR.md`](STAFF_SCHEDULE_AND_CALENDAR.md) | Floor staff schedule, **`staff_effective_working_day`**, morning dashboard **`today_floor_staff`** |
| [`scripts/apply-migrations-psql.sh`](../scripts/apply-migrations-psql.sh) | Production-friendly migration apply via `psql` + `DATABASE_URL` |

---

*Align **About this build** and your release bundle name so store staff and support share the same version vocabulary.*
