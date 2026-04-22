# Riverside OS — Local update protocol (offline / no GitHub)

Canonical runbook for moving a **single store** from **version A → version B** when you **do not** use GitHub (or any hosted CI). Artifacts are built on a developer machine and delivered via **USB drive, SMB share, zip**, or equivalent.

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
| **SQL migrations** | Full `migrations/` tree **or** at least every `NN_*.sql` file **new since** the last production deploy (numbered order must remain intact). |
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

### 5.1 Backup (mandatory)

Create a **fresh** database backup before any migration or binary swap.

- **In-app:** Back Office → Settings → backups: use **Create backup**, or call **`POST /api/settings/backups/create`** with appropriate staff auth (see [`BACKUP_RESTORE_GUIDE.md`](../BACKUP_RESTORE_GUIDE.md)).
- **Or manual:** `pg_dump` to a dated file on disk or your standard path.

Confirm the backup file exists and has non-trivial size before continuing.

### 5.2 Stop the API

Stop the Riverside OS HTTP process **cleanly** (no hard kill mid-request if avoidable).

Document **your** method here (examples only):

- Close the console window if you run `riverside-server` manually.
- Stop a **scheduled task** or **Windows service** if you use one (NSSM and similar are store-specific; not shipped in-repo).

Until the process is stopped, do not replace the binary or the static `dist` tree.

### 5.3 Apply database migrations

Migrations live in `migrations/NN_description.sql` and are tracked in **`public.ros_schema_migrations`** (see `migrations/00_ros_migration_ledger.sql`). **Never** skip the ledger inserts: the apply scripts record each applied filename.

**Option A — same machine has bash and `psql` (WSL, Git Bash, macOS/Linux build box with VPN to DB):**

From a checkout that contains the **`migrations/`** folder for this release:

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"
./scripts/apply-migrations-psql.sh
```

**Option B — manual `psql` (mirror of [`scripts/apply-migrations-docker.sh`](../scripts/apply-migrations-docker.sh)):**

1. Ensure the ledger table exists (bootstrap `00_ros_migration_ledger.sql` once if needed; then insert `00_ros_migration_ledger.sql` into `ros_schema_migrations` if not present).
2. For each `migrations/[0-9][0-9]_*.sql` in **sorted order**, if `version` is not already in `ros_schema_migrations`:
   - `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /path/to/that/file.sql`
   - `INSERT INTO ros_schema_migrations (version) VALUES ('NN_whatever.sql') ON CONFLICT (version) DO NOTHING;`

If any file fails, **stop** and restore from backup (section 8) or fix forward with engineering — do not start the new server against a half-applied chain.

**Staff sign-in after updates:** Migration **`53_default_admin_chris_g_pin.sql`** (if included in your chain) sets the bootstrap **Chris G** admin to **four-digit** code **`1234`** with an Argon2 hash of **`1234`**. If you rely on a different staff roster, run your usual seed or adjust **`staff`** rows so at least one user can sign into Back Office (see **`docs/STAFF_PERMISSIONS.md`**). E2E and fresh dev DBs also use **`scripts/seed_staff_register_test.sql`** alongside that migration.

### 5.4 Deploy binary and static UI

The server serves the SPA from **`FRONTEND_DIST`**. If unset, development falls back to **`../client/dist`** relative to the **process working directory**, but production service installs should treat that as unsafe. On hardened production hosts, set **`RIVERSIDE_STRICT_PRODUCTION=true`** and provide an explicit **`FRONTEND_DIST`** path so startup refuses a missing or wrong static bundle directory.

1. Replace the **server executable** with the one from the release bundle.
2. Replace the **contents** of the static UI directory (the folder pointed to by `FRONTEND_DIST`):
   - Prefer **atomic swap:** copy new files to `dist.new`, then rename/swap with `dist` to avoid half-written assets if a client requests mid-copy.

### 5.5 Environment variables

Merge any **new** keys from release notes into the server’s `.env` (or system environment). Never commit production secrets. Full reference: [`DEVELOPER.md`](../DEVELOPER.md).

Pay attention to:

- `DATABASE_URL`
- `RIVERSIDE_CORS_ORIGINS` (production browser allowlist)
- `RIVERSIDE_STRICT_PRODUCTION=true` (recommended for browser-facing production hosts)
- `RIVERSIDE_STORE_CUSTOMER_JWT_SECRET` (required when `/api/store/account/*` is exposed)
- `FRONTEND_DIST` (explicit deployed static bundle path)
- `RIVERSIDE_HTTP_BIND` / firewall alignment — [`STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md) section 4
- Optional caps and integrations (`RIVERSIDE_MAX_BODY_BYTES`, weather, backup S3, etc.)
- ROS-AI help RAG: **`RIVERSIDE_REPO_ROOT`** (absolute path to the deployed tree that contains **`docs/staff/CORPUS.manifest.json`**) if you use **`POST /api/ai/admin/reindex-docs`**; **`AI_EMBEDDINGS_ENABLED`** to disable ONNX embeddings on constrained hosts — [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md)

### 5.6 Start the API

Start the server the same way you normally do; confirm it listens on the expected address (default `0.0.0.0:3000` unless overridden).

### 5.7 Smoke test

Before announcing “all clear”:

1. Load the app in a browser at your production origin; confirm login.
2. Open **Register** (or Back Office): one read path (e.g. search) and one low-risk write if policy allows.
3. Optional: `SELECT version FROM ros_schema_migrations ORDER BY version;` — last row should match the latest `NN_*.sql` you shipped (compare with release notes / repo **`migrations/`**). For deeper drift checks in dev/Docker, see [`scripts/migration-status-docker.sh`](../scripts/migration-status-docker.sh) and [`scripts/ros_migration_build_probes.sql`](../scripts/ros_migration_build_probes.sql) (adapt queries to your prod DB as needed).
4. If you ship **new or changed** `docs/staff/**` or **`CORPUS.manifest.json`**, run a **staff help reindex** once the API is up (**`settings.admin`**) — [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md).

### 5.8 Post-update smoke matrix (required before all-clear)

Validate each deployment surface against its real role:

1. **HOST machine**
   - Start **Shop Host**.
   - Confirm running state, bind address, frontend bundle, and local satellite URL.
   - Confirm a second same-network device reaches the sign-in gate from that local satellite URL.
2. **MAIN REGISTER machine**
   - Launch the Windows Tauri app.
   - Confirm sign-in, register readiness, one sale path, and printer recovery path per the Windows checklist.
3. **Local iPad / phone PWA**
   - Confirm the device is on the same local network as the host.
   - Confirm it uses the local host URL, not the Tailscale path.
   - Confirm sign-in and the expected shell/search/status flow for that device class.
4. **Remote PWA over Tailscale**
   - Confirm the device is off-site or off the store LAN.
   - Confirm it reaches Riverside through the Tailscale remote path.
   - Confirm one low-risk remote workflow such as customer search or order lookup.

---

## 6. Workstations (Tauri / desktop)

For role clarity during rollout:

- the **HOST machine** and the **MAIN REGISTER** are different Windows Tauri machines
- only the dedicated host machine should be used for **Shop Host**
- updating a register station does not automatically make it the host

Use the desktop updater release pipeline (`.github/workflows/tauri-register-updater-release.yml`) for recurring Windows updates:

1. Run the workflow after business hours with:
   - GitHub variable: `RIVERSIDE_UPDATER_PUBLIC_KEY` (from `~/.tauri/riverside-updater.key.pub`)
   - GitHub secret: `TAURI_SIGNING_PRIVATE_KEY` (+ optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
2. The workflow publishes `updater-dist/latest.json`, updater artifact, and `.sig` file to the GitHub release tag for that version.
3. On stations, use **Settings → General → About this build → Check for updates / Install update**.
4. Keep the previous installer available for rollback.

If you need a manual fallback, install/replace with the latest MSI/NSIS build.

**`VITE_API_BASE`** remains fixed **at build time** — any desktop rebuild must still target the same API origin staff use (LAN hostname, HTTPS URL, etc.). See [`STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md) section 3.2.

---

## 7. PWA / tablets / phones

1. Open the app; if Riverside shows the **PWA update prompt**, use **Reload now** when staff can afford a quick refresh.
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
| [`DEVELOPER.md`](../DEVELOPER.md) | Env vars, migration index |
| [`README.md`](../README.md) | Dev quick start; Docker migration scripts for local dev |
| [`docs/ROS_AI_HELP_CORPUS.md`](ROS_AI_HELP_CORPUS.md) | Staff help RAG reindex after deploy; **`RIVERSIDE_REPO_ROOT`**, embeddings env |
| [`docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`](STAFF_TASKS_AND_REGISTER_SHIFT.md) | Migrations **55–56**: register shift primary, staff recurring tasks, new RBAC keys |
| [`docs/STAFF_SCHEDULE_AND_CALENDAR.md`](STAFF_SCHEDULE_AND_CALENDAR.md) | Migrations **57–58**: floor staff schedule, **`staff_effective_working_day`**, morning dashboard **`today_floor_staff`** |
| [`scripts/apply-migrations-psql.sh`](../scripts/apply-migrations-psql.sh) | Production-friendly migration apply via `psql` + `DATABASE_URL` |

---

*Align **About this build** and your release bundle name so store staff and support share the same version vocabulary.*
