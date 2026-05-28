# Riverside OS Deployment Manager Manual

The **Riverside OS Deployment Manager** (`RiversideOS-Deployment-Manager.exe`) is the universal graphical hub for installing, updating, auditing, repairing, and resetting in-store Riverside OS workstations and server installations. 

For day-to-day Server PC operations after installation, use the separate **ROS Server Manager** (`ROS-ServerManager.exe`). It runs locally, does not require the Riverside API to be online, and is focused on server health, repairs, cleanup, updates, and recovery. See [`ROS_SERVER_MANAGER.md`](ROS_SERVER_MANAGER.md).

Replacing the legacy WinForms-based and command-line scripts, it provides a unified, cross-station desktop dashboard that interfaces directly with local system configuration, services, database engines, and diagnostic tools.

---

## Key Capabilities

*   **Elevated Run-Time Authority**: Launches automatically as Administrator to manage system-level scheduled tasks, database engines, network firewalls, and configuration directories (`C:\RiversideOS` and `C:\ProgramData\RiversideOS`).
*   **Zero-Config Self-Healing Credentials**: Automatically detects PostgreSQL authentication patterns (trust/defaults) and generates cryptographically secure, URL-safe secrets and database passwords, saving them back to the configuration file.
*   **Comprehensive System Audit Diagnostics**: Performs an edge-to-edge system health check, mapping permissions, port availability, database versioning, background tasks, and printer reachability.
*   **Single-Click 'Start Fresh' (Factory Reset)**: Wipes the existing schema, creates a clean UTF8 database, applies all migrations, and runs core required seeds silently in a single click.
*   **High-Speed Pipeline Compilation**: Fully integrated into the GitHub Actions CI/CD pipeline, utilizing advanced compiler caching to compile and package the manager binary automatically in under 8 minutes.

---

## 1. Directory & Package Layout

Within the packaged Windows deployment ZIP, the files are structured as follows:

```text
RiversideOS-v[Version]-Windows-Deployment/
  Start-RiversideDeployment.cmd          <-- Primary double-click launcher
  RiversideOS-Deployment-Manager.exe     <-- Compiled Tauri GUI App
  Audit-System.cmd                       <-- Diagnostic double-click utility
  audit-system.ps1                       <-- Core pre-flight checking script
  install-server.ps1                     <-- Server installation logic (Main Hub)
  install-register.ps1                   <-- Register / workstation installer
  remove-main-hub.ps1                    <-- Full server + app removal
  remove-standalone-app.ps1              <-- App-only removal
  apply-riverside-migrations.ps1         <-- Schema updater
  reset-riverside-database.ps1           <-- Schema wiper and re-creator
  riverside-deployment.config.json       <-- Local configuration state
  server/
    riverside-server.exe                 <-- Compiled Axum API binary
  client-dist/                           <-- Compiled React frontend files
  migrations/                            <-- SQL migrations directory
  seeds/                                 <-- Core required start/RBAC seeds
  register/                              <-- Register MSI/EXE installers
```

### macOS ROS Dev Center

The **ROS Dev Center** (`ros-dev`) is a separate macOS DevOps companion app built as a universal Apple Silicon / Intel DMG via `.github/workflows/macos-ros-dev-center-release.yml`. It connects to any ROS instance for real-time monitoring, GitHub integration, and one-click release builds. Download the `.dmg` from the matching release tag and install like any standard macOS application. See [`ros-dev/README.md`](../ros-dev/README.md) for setup and usage.

---

## 2. Installation Roles

The Deployment Manager supports **three distinct installation roles**. Choose exactly one per workstation:

| Role | What it installs | Use on |
|------|----------------|--------|
| **Main Hub** | PostgreSQL, `riverside-server.exe`, web bundle, migrations, firewall rule, startup task, and the Riverside desktop app | The single Windows PC that is the store server and may also serve as a back-office workstation. |
| **Standalone App — Back Office** | Riverside desktop app only, pointed at the Main Hub API | A non-server Windows PC used for back-office work (customers, orders, inventory, reports). |
| **Standalone App — Register #1** | Riverside desktop app only, pointed at the Main Hub API, with receipt-printer and cash-drawer settings | The primary cashier Windows PC. Must be a different PC than the Main Hub in production. |

**Rules:**
- Only **one** Main Hub exists per store.
- Register #1 should be a **separate physical PC** from the Main Hub for production reliability.
- Back Office workstations are lightweight: no PostgreSQL, no server task, just the desktop app.

---

## 3. Elevated Launcher Flow

To guarantee that local configuration writing, service registration, and network binding succeed, the Deployment Manager must run with administrator privileges.

### Double-Click Entry Point
When an operator double-clicks **`Start-RiversideDeployment.cmd`**, the script executes the following logic:
1. Checks for the presence of **`RiversideOS-Deployment-Manager.exe`**.
2. If found, it invokes a PowerShell script wrapper to trigger a User Account Control (UAC) prompt and run the executable elevated:
   ```powershell
   Start-Process -FilePath "RiversideOS-Deployment-Manager.exe" -Verb RunAs
   ```
3. If the compiled manager binary is missing (e.g. legacy/development environment), the script safely falls back to launching the command-line/WinForms setup utility.

---

## 3. Zero-Config Password Auto-Resolution & Generation

To prevent setup failures caused by misconfigured passwords or unreplaced placeholder tokens, all database and app scripts are self-healing.

### Automatic Secret and App Password Generation
When `install-server.ps1` or `apply-riverside-migrations.ps1` runs:
*   **JWT Secret:** If `storeCustomerJwtSecret` in the configuration is empty or matches a placeholder (e.g. `replace-with-...`), the script generates a secure 32-character token.
*   **App DB User Password:** If `appPassword` is empty or matches a placeholder, the script generates a secure 24-character database password.
*   **Auto-Save:** Generated secrets are automatically written back to the `riverside-deployment.config.json` configuration file, ensuring they are persistent and won't be lost during updates.

### Postgres Admin Password Auto-Detection
If the PostgreSQL admin password is left blank or as a placeholder:
*   The script attempts to connect to the local PostgreSQL instance on port 5432 using **empty/blank credentials** (checking for standard dev "trust authentication").
*   If that fails, it cycles through common default admin passwords (`postgres`, `admin`, `password`).
*   If a connection is successfully established, the script **automatically writes the working password** to `riverside-deployment.config.json`.
*   If no local instance is found, and the manager is installing a new PostgreSQL instance, it generates a new admin password and registers it.

---

## 4. Deep Pre-flight System Audit

Clicking the **Audit** button in the Deployment Manager (or running `Audit-System.cmd`) triggers the **`audit-system.ps1`** diagnostic utility. It validates the host environment and prints a color-coded status log:

| Check Target | Diagnostic Method | Recovery Action |
| :--- | :--- | :--- |
| **Admin Permissions** | Verifies Windows Security Principal is Administrator. | Throws warning to relaunch script elevated. |
| **Port Reachability** | Checks if TCP Port 5432 (PostgreSQL) is open. | Identifies if database service is stopped. |
| **Database Connection** | Attempts SQL check query using resolved credentials. | Validates config credentials and database existence. |
| **Schema & Migrations** | Queries table counts and checks `ros_schema_migrations`. | Identifies if migrations are pending or unapplied. |
| **Server Task Status** | Audits state of `"Riverside OS Server"` scheduled task. | Checks if task is registered, active, or terminated. |
| **API Health** | Pings port 3000 `/api/version` and `/api/staff/list-for-pos`. | Verifies Axum server is responding to HTTP traffic. |
| **System Environment** | Audits machine-level `RIVERSIDE_CREDENTIALS_KEY` variable. | Confirms API server has access to encryption keys. |
| **Printer Connectivity** | Pings IPs defined in `receiptPrinter` / `tagPrinter` settings. | Identifies routing/firewall issues for ticket printers. |

---

## 5. Maintenance Commands

The Deployment Manager provides a suite of dashboard buttons to manage local database operations:

```
┌────────────────────────────────────────────────────────┐
│                  DATABASE MAINTENANCE                  │
├────────────────────────────────────────────────────────┤
│  [ Apply Migrations ]     -->  Runs pending schemas    │
│  [ Seed Database ]        -->  Applies required data   │
│  [ Start Fresh ]          -->  Zero-Config Factory Reset│
└────────────────────────────────────────────────────────┘
```

### Apply Migrations
Runs `apply-riverside-migrations.ps1`. Reads the migration ledger `ros_schema_migrations` and applies any new numbered SQL scripts (from the `migrations/` directory) using `psql.exe`.

### Seed Database
Runs the core and RBAC seed scripts (`seeds/seed_core_required.sql` and `seeds/seed_rbac.sql`). Establishes standard store settings, system configuration, permission templates, and registers the fallback admin profile:
*   **Username:** `Chris G`
*   **Access PIN:** `1234`
*   **Role:** `admin`

### Start Fresh (Factory Reset)
The **Start Fresh** option completely drops the local database, recreates it from scratch, applies all schema migrations, and seeds the default production data in a single step.

> [!WARNING]
> This operation is highly destructive and will permanently delete all transaction history, customers, and inventory data on this workstation. It should only be used on new workstations or when recovering a failed initial setup.

```mermaid
graph TD
    A[Start Fresh Clicked] --> B[React GUI Confirmation]
    B -- Yes --> C[Invoke reset-riverside-database.ps1 -StartFresh]
    C --> D[Terminate active DB connections]
    D --> E[Drop & Recreate Database UTF8]
    E --> F[Apply Migrations apply-riverside-migrations.ps1]
    F --> G[Apply Seed Files seed_core_required & seed_rbac]
    G --> H[Print Success Log to Terminal Viewer]
```

To prevent blocking dialog boxes when triggered from the Tauri GUI log terminal, passing `-StartFresh` suppresses all WinForms MessageBox popups.

---

## 6. Removal Commands

The Deployment Manager can cleanly remove Riverside OS from a workstation. The removal path depends on the original installation role.

### Remove Main Hub (`remove-main-hub.ps1`)

Removes the **full server installation** from a Main Hub workstation:

- Stops and unregisters the `Riverside OS Server` and `Riverside OS LLM Host` scheduled tasks.
- Stops running `riverside-server` and `llama-server` processes.
- Uninstalls the Riverside desktop app via MSI/registry.
- Removes firewall rules (`Riverside OS Server`, `Riverside OS API`, `Riverside OS LLM Host`).
- Drops the `riverside_os` PostgreSQL database (unless `--KeepDatabase` is passed).
- Removes station configurations and the install root (unless `--KeepInstallRoot` is passed).

Requires Administrator elevation. Prompts for `REMOVE` confirmation unless `--Force` is passed.

### Remove Standalone App (`remove-standalone-app.ps1`)

Removes a **desktop-app-only installation** from a Back Office or Register workstation:

- Stops running Riverside client processes.
- Uninstalls the Riverside desktop app via MSI and registry uninstall strings.
- Removes station configurations.

Does **not** touch PostgreSQL, the server task, or firewall rules. Use this for Back Office workstations and Register #1 PCs when they are being retired or reimaged.

Requires Administrator elevation. Prompts for `REMOVE` confirmation unless `--Force` is passed.

---

## 7. Password & Security Management

The Deployment Manager includes automated self-healing scripts to recover from lost credentials or corrupted configuration files, improving ease of use for retail operators.

### Repair Server Credentials Key (`repair-server-credentials-key.ps1`)
If the server loses its encryption keys or the `.env` file is corrupted, this command:
1. Verifies administrative rights and checks the `.env` state.
2. Validates `RIVERSIDE_CREDENTIALS_KEY` and `RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`.
3. If missing or invalid, generates cryptographically secure 48-character replacement secrets.
4. Writes them to the `.env` file and Windows Machine-level environment variables.
5. Safely restarts the `Riverside OS Server` scheduled task to pick up the new keys.

### Repair Bootstrap Admin (`repair-bootstrap-admin.ps1`)
In case of complete lockout, this script forcefully resets the primary administrative account to the factory default PIN (`1234`) and ensures the profile retains the `admin` role, restoring Back Office access.

---

## 8. Integrations & AI Add-ons

The manager exposes utilities to connect and enhance the Riverside OS environment after the core system is installed.

### Install ROSIE AI Stack (`Install-RosieAiStack.ps1`)
Downloads and configures the local AI copilot dependencies (Gemma GGUF models, SenseVoice, and Kokoro TTS) into the `%LOCALAPPDATA%\riverside-os\rosie` directory, ensuring offline capabilities are ready for the ROSIE worker.

### Set Counterpoint Bridge Token (`set-counterpoint-bridge-token.ps1`)
Generates or rotates the 48-character `COUNTERPOINT_SYNC_TOKEN` required to secure the bridge between Riverside OS and legacy NCR Counterpoint POS systems.

---

## 9. Development & Compilation Architecture

The Deployment Manager is a Tauri v2 application composed of a **Vite + React + TS** frontend (`deployment/manager-app/src`) and a **Rust** backend (`deployment/manager-app/src-tauri`).

### Tauri Command Bridge
The frontend interacts with Windows PowerShell by invoking custom Rust handlers defined in `lib.rs`:

```rust
// Invokes a powershell script in bypass mode, passing optional arguments
#[tauri::command]
async fn run_deployment_script(app: AppHandle, script_name: String, args: Option<Vec<String>>) -> Result<(), String>;

// Executes inline commands directly
#[tauri::command]
async fn run_inline_powershell(app: AppHandle, script_content: String) -> Result<(), String>;
```

Logs are emitted asynchronously from Rust back to the Vite console using the `deployment-log` event emitter, allowing operators to monitor script output in real time.

### GitHub Actions CI/CD Pipeline
The deployment manager packaging is automated in two workflows:
- **Windows**: `.github/workflows/windows-deployment-package.yml` — builds the full Windows deployment ZIP (server binary, client bundle, register updater, and Deployment Manager executable).
- **macOS**: `.github/workflows/macos-ros-dev-center-release.yml` — builds a universal Apple Silicon / Intel DMG for the ROS Dev Center.

Both pipelines utilize **`swatinem/rust-cache`** to cache downloaded Rust dependencies across runs. The Windows workspace builds three targets sequentially in one job:
1.  `client/src-tauri` (Tauri Client Desktop application)
2.  `server` (Axum Backend server executable)
3.  `deployment/manager-app/src-tauri` (Deployment Manager executable)

Full Windows deployment package builds realistically take **20–30 minutes** (dependency caching saves time on crates that did not change between runs). macOS ROS Dev Center builds are faster at approximately **15 minutes** since only one Tauri app is compiled. The Windows runner automatically packages the compiled executable in the final zip file as `RiversideOS-Deployment-Manager.exe`.
