# Riverside OS Windows installer package

This package is the guided deployment path for the in-store Windows machines:

- **Main Hub (Backoffice / Server PC)**: PostgreSQL database, Riverside server, local Meilisearch search runtime, web bundle, migrations, firewall rule, startup tasks, and the Riverside desktop app.
- **Standalone App — Register #1**: Riverside desktop app, station API base, printer target, and cash drawer setting. No server or database.
- **Standalone App — Back Office**: Riverside desktop app, station API base, and optional printer targets. No server or database.

The normal entry point is **`Install-ROSDeploymentApps.cmd`**. It installs the Riverside OS Deployment Manager, ROS Server Manager, or both as standard Windows apps so they can be launched from Start and updated through their in-app updater channels. **`Start-RiversideDeployment.cmd`** remains in the package as a support fallback launcher.

## Package layout

Build output:

```text
RiversideOS-v0.80.9-Windows-Deployment/
  Start-RiversideDeployment.cmd
  Start-RiversideDeployment.ps1
  Install-ROSDeploymentApps.cmd
  Install-ROSDeploymentApps.ps1
  install-server.ps1
  install-register.ps1
  remove-main-hub.ps1
  remove-standalone-app.ps1
  Install-RosieAiStack.cmd
  Repair-RiversideCredentialsKey.cmd
  riverside-deployment.config.example.json
  server/riverside-server.exe
  client-dist/
  migrations/
  register/
  deployment-app/
  server-manager-app/
  counterpoint-bridge-gui/
  meilisearch/meilisearch.exe
  rosie/bin/
  rosie/stt/
  rosie/tts/
  docs/
```

## Build the package

From a Windows release machine after building the server, client, and Tauri bundle:

```powershell
.\deployment\windows\build-deployment-package.ps1 -Version "0.80.9"
```

If the Tauri register bundle is coming from GitHub Actions instead of the local machine, copy the downloaded MSI into the package's `register/` folder before running `install-register.ps1`. For v0.80.0 and later, do not mix the `server/`, `client-dist/`, or `register/` folders from different release zips. Updater manifests, signatures, and standalone updater installers are published as GitHub release assets instead of being duplicated inside the deployment ZIP.

## Configure the package

Normal path:

```text
Double-click Install-ROSDeploymentApps.cmd, install the Deployment Manager and/or ROS Server Manager, then launch Riverside OS Deployment Manager from Start.
```

Then choose one of the three roles:

- **Main Hub** for the server PC (PostgreSQL + Riverside Server + desktop app).
- **Standalone App — Register #1** for the primary cashier lane.
- **Standalone App — Back Office** for a non-server PC that runs Riverside against the Main Hub.

Click **Check**, then choose the action:

- **Install** for a new station.
- **Update** to apply a newer package, copy new files, run migrations where needed, and reinstall/update the workstation app.
- **Repair** to rewrite station/server settings and fix service/firewall/printer/API setup without a destructive reset.
- **Remove** to uninstall Riverside from that station using the appropriate removal script (`remove-main-hub.ps1` or `remove-standalone-app.ps1`).

The Deployment Manager writes `riverside-deployment.config.json` for the selected station role and runs the correct installer or removal script.

The manager shows all command output in the full-width **Execution Output** console. Use **Copy Logs** to place the current log buffer on the clipboard for support. The release package also keeps logs under the installed `C:\RiversideOS\logs` path where applicable.

Main Hub deployment packages stamp the installed server and database as `production` (`RIVERSIDE_MODE=production` and `store_settings.environment_mode='production'`). `RIVERSIDE_STRICT_PRODUCTION` is a separate hardening gate and may remain `false` until live payment credentials are configured.

## Passwords and secrets

The Deployment Manager keeps the password work inside the installer flow:

- **PostgreSQL install**: if PostgreSQL is missing, the manager can offer to install PostgreSQL 18 through Windows Package Manager. This needs internet access and the normal Windows Package Manager service.
- **PostgreSQL admin password**: enter the existing PostgreSQL `postgres` password when installing, updating, or repairing the Server. The installer needs it to create/update the Riverside database user, fix permissions, and run migrations.
- **New PostgreSQL admin password**: if PostgreSQL is installed by the manager and the field is blank or placeholder, the manager generates a password and writes it to `riverside-deployment.config.json`.
- **Riverside database password**: generated automatically if left blank or still set to a placeholder. It is saved to `riverside-deployment.config.json` and written to `C:\RiversideOS\server\.env`.
- **Riverside app secret**: generated automatically if left blank, too short, or still set to a placeholder.
- **Integration credential encryption key**: written as `RIVERSIDE_CREDENTIALS_KEY` in `C:\RiversideOS\server\.env` and the Windows machine environment. This must be present before Backoffice Settings can save Helcim, QBO, Counterpoint, or other encrypted integration credentials.
- **Meilisearch**: the Main Hub installer copies `meilisearch\meilisearch.exe` to `C:\RiversideOS\meilisearch`, registers the **Riverside OS Meilisearch** startup task on `http://127.0.0.1:7700`, and writes `RIVERSIDE_MEILISEARCH_URL` plus `RIVERSIDE_MEILISEARCH_API_KEY` to the server `.env`. After a reset, restore, or Counterpoint import, rebuild search from **Settings → Integrations → Meilisearch**.
- **Counterpoint Bridge GUI**: included under `counterpoint-bridge-gui\`. Use it on the Counterpoint host to connect Counterpoint SQL directly to Main Hub ROS on port `3000`; no separate SYNC app or bridge-token helper is part of the go-live package path.
- **Register and Back Office station settings**: written automatically to `C:\ProgramData\RiversideOS\station-config.json`.

Generated Riverside passwords intentionally use URL-safe letters and numbers so PostgreSQL connection strings do not break on characters like `#`, `@`, or `%`.

## Update, repair, and uninstall

The same Deployment Manager handles later maintenance:

- **Server Manager status**: shows whether the `Riverside OS Server` scheduled task exists/runs, whether `/api/version` is reachable, the installed server version, the package version, and the next action.
- **Server update**: copies the new server and web files for the same Riverside release, applies pending migrations, refreshes the firewall/task setup, and restarts Riverside.
- **Workstation update**: rewrites station settings and installs the included Riverside desktop app package for the same Riverside release.
- **Server repair**: reruns the server setup in an idempotent way to restore service, firewall, env, and migration state.
- **Workstation repair**: rewrites station settings without reinstalling the app.
- **Workstation uninstall**: removes the Riverside desktop app and station settings.
- **Server uninstall**: removes the server scheduled task, firewall rule, and app files. It keeps the database, backups, and logs by default.

For a clean pre-go-live database reset, run `Reset-RiversideDatabase.cmd` from the packaged release folder on the Main Hub. The wrapper prompts for confirmation, deletes and recreates the Riverside database, applies all packaged migrations, and applies only the required seed data. Do not use it after production transactions exist unless the intent is to discard all store/import data and start over.

Server, Windows app, and PWA/web files are one release. After any update, open **Settings → Updates** and confirm it shows the expected **Riverside version**. If it shows **Update incomplete**, finish the matching server or workstation update before using that station for production work.

If Riverside Settings cannot open because the API is down, manage the server from Windows instead:

1. On the Main Hub PC, open the release package folder.
2. Run **`Start-RiversideDeployment.cmd`**.
3. Select **Main Hub**.
4. Use **Refresh Server Status**.
5. If the package version is newer than the installed server version, run **Update This Server PC**.
6. If the server task is missing or the API is unreachable, run **Repair Server** or use **Start Server** / **Restart Server**.

Hotfix/support actions included in v0.80.9 packages:

- **`Install-RosieAiStack.cmd`** copies the precompiled ROSIE AI binaries (llama-server, sherpa-onnx) and bundled STT/TTS model files, verifies the Gemma GGUF model integrity, patches the server `.env` to make the local LLM reachable, and restarts the server. Use this to restore ROSIE AI features on existing Server PCs without a full reinstall.
- **`Repair-RiversideCredentialsKey.cmd`** repairs the installed server credential key, writes it to both `C:\RiversideOS\server\.env` and the Windows machine environment, and restarts the `Riverside OS Server` task. Use this when Backoffice Settings says `RIVERSIDE_CREDENTIALS_KEY` must be set before integration credentials can be saved.
Manual fallback:

```powershell
Copy-Item .\riverside-deployment.config.example.json .\riverside-deployment.config.json
```

Fill in:

- PostgreSQL admin/app credentials.
- `DATABASE_URL` parts through the `server.database` fields.
- `RIVERSIDE_CORS_ORIGINS` through `server.corsOrigins`.
- Store secrets in `server.environment`.
- Set `RIVERSIDE_PUBLIC_BASE_URL` and `RIVERSIDE_CLOUDFLARE_TUNNEL_HOSTNAME` in `server.environment` when Helcim/Podium webhooks should use Cloudflare Tunnel.
- Register #1 API base and printer settings under `register`.

Credentials may be included in this private in-store package. Do not commit the filled `riverside-deployment.config.json` to the repo.

## Main Hub install

Preferred path:

```text
Double-click Start-RiversideDeployment.cmd and choose Main Hub.
```

Manual fallback:

```powershell
.\install-server.ps1
```

The script:

- Creates `C:\RiversideOS` folders.
- Starts the PostgreSQL Windows service when it is installed but stopped.
- Copies `riverside-server.exe`.
- Copies `client-dist`.
- Copies migrations.
- Copies bundled docs into `C:\RiversideOS\release\docs` for help/reindex workflows when enabled.
- Creates/updates the PostgreSQL app role and database.
- Applies pending migrations using `psql`.
- Extracts precompiled ROSIE binaries (llama-server, sherpa-onnx-offline, sherpa-onnx-offline-tts), copies bundled STT/TTS model files, and verifies the Gemma GGUF model hash (matching `MODEL_PIN.json`).
- Writes `C:\RiversideOS\server\.env`.
- Verifies or repairs the local `cloudflared` ingress so the configured tunnel hostname points to the Riverside server port.
- Adds the inbound firewall rule for the configured server port.
- Creates a startup scheduled task named `Riverside OS Server`.
- Starts the server and checks the local app URL.

If Riverside starts but a screen reports a missing database table, use **Apply-RiversideMigrations.cmd** from the release package. It only applies pending migrations; it does not replace the server, web bundle, or desktop app.

The Backoffice / Server desktop app also has a local recovery path: if it opens on the server PC, is pointed at `localhost` / `127.0.0.1`, and the roster check cannot reach the API, it asks Windows to start the installed `Riverside OS Server` scheduled task and then retries the roster check. If the task is missing, run **Repair** from the Deployment Manager instead of manually creating a different task name.

PostgreSQL and `psql.exe` must be installed or referenced by `server.database.psqlPath`. The Deployment Manager can find common PostgreSQL installs and write the path into the config.

API host rule:

- On the **Main Hub PC**, the Riverside desktop API host should be `http://127.0.0.1:3000`.
- On **Register #1**, **Back Office Workstation**, and iPad/PWA devices, the API host should be the Main Hub PC LAN address with port 3000, for example `http://10.64.70.196:3000`.

## Standalone App — Register #1 install

Preferred path:

```text
Double-click Start-RiversideDeployment.cmd and choose Standalone App — Register #1.
```

Manual fallback:

```powershell
.\install-register.ps1
```

The script:

- Writes `C:\ProgramData\RiversideOS\station-config.json`.
- Installs the MSI/EXE found under `register/`.
- Launches the Riverside desktop app when possible.

On first launch, the Tauri app imports `station-config.json` and saves:

- API base: `ros_api_base_override`
- Receipt printer mode/address/name
- Expected tag printer queue name: **Zebra LP 2844**; select the exact installed queue in Riverside Printers & Scanners
- Report printer mode/address/name
- Cash drawer setting

If settings changed, the app reloads once so early API calls use the installed API base.

The packaged Windows app icon should show the Riverside logo mark. A solid red square means the station is running an older placeholder-icon build and should be updated with the current register/workstation artifact.

## Standalone App — Back Office install

Preferred path:

```text
Double-click Start-RiversideDeployment.cmd and choose Standalone App — Back Office.
```

This uses the workstation installer path, writes the Main Hub API base, disables cash drawer by default, and installs the Riverside desktop app without setting up PostgreSQL or the server task.

## Printer recommendation

For **Register #1 Epson receipts and cash drawer**, prefer:

```json
"receiptPrinter": {
  "mode": "network",
  "ip": "192.168.1.50",
  "port": 9100
}
```

Use installed-printer mode for USB printers, report/label printers that need Windows driver sizing, or fallback:

```json
"receiptPrinter": {
  "mode": "system",
  "systemName": "EPSON TM-m30III Receipt"
}
```

For clothing tags, Windows must expose the installed LP 2844 printer queue and Riverside Printers & Scanners must select that exact queue. Inventory tag actions send **EPL2** directly to the saved Tag Station target; a failed hardware route must be corrected before relying on tag printing.

For **iPad/PWA receipts**, Riverside does not use the browser print dialog for receipts. The PWA sends the print request to the Riverside Server API, and the server dispatches directly to the Epson IP/port. If the server cannot reach the printer, fix the printer IP, port, firewall, or network before using the lane.

For **reports and audit paperwork**, browser or Windows print remains acceptable. Reports are not routed through the Epson receipt-printer direct TCP path.

## Remaining manual smoke

The package gets the machines close to ready, but still verify:

- Server loads from another device.
- Register #1 can sign in and open the till.
- Receipt test prints.
- Cash drawer opens for cash/check.
- Scanner input reaches POS search.
- One supervised sale or dry-run path is completed.
