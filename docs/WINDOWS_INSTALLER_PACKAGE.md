# Riverside OS Windows installer package

This package is the guided deployment path for the in-store Windows machines:

- **Backoffice / Server PC**: PostgreSQL database, Riverside server, web bundle, migrations, firewall rule, and startup task.
- **Register #1**: Riverside desktop app, station API base, printer target, and cash drawer setting.
- **Back Office Workstation**: Riverside desktop app, station API base, and optional printer targets without server/database setup.

The primary entry point is **`Start-RiversideDeployment.cmd`**. It opens the Riverside OS Deployment Manager so the installer can be run by choosing the station type, checking readiness, and clicking install. The package still keeps a readable JSON config next to the installers for support fallback.

## Package layout

Build output:

```text
RiversideOS-v0.70.0-Windows-Deployment/
  Start-RiversideDeployment.cmd
  Start-RiversideDeployment.ps1
  install-server.ps1
  install-register.ps1
  Install-RosieAiStack.cmd
  Repair-RiversideCredentialsKey.cmd
  Set-CounterpointBridgeToken.cmd
  riverside-deployment.config.example.json
  server/riverside-server.exe
  client-dist/
  migrations/
  release-docs/
  register/
  docs/
```

## Build the package

From a Windows release machine after building the server, client, and Tauri bundle:

```powershell
.\deployment\windows\build-deployment-package.ps1 -Version "0.70.0"
```

If the Tauri register bundle is coming from GitHub Actions instead of the local machine, copy the downloaded MSI into the package's `register/` folder before running `install-register.ps1`. For v0.70.0 and later, do not mix the `server/`, `client-dist/`, `register/`, or `updater/` folders from different release zips.

## Configure the package

Normal path:

```text
Double-click Start-RiversideDeployment.cmd.
```

Then choose:

- **Backoffice / Server** for the server PC.
- **Register #1** for the register lane.
- **Back Office Workstation** for a non-server PC that runs Riverside against the server.

Click **Check**, then choose the action:

- **Install** for a new station.
- **Update** to apply a newer package, copy new files, run migrations where needed, and reinstall/update the workstation app.
- **Repair** to rewrite station/server settings and fix service/firewall/printer/API setup without a destructive reset.
- **Uninstall** to remove Riverside from that station.

The Deployment Manager writes `riverside-deployment.config.json` for the selected station type and runs the correct installer.

The manager also writes `deployment-manager.log` next to the installer so support can review exactly what was checked or installed.

## Passwords and secrets

The Deployment Manager keeps the password work inside the installer flow:

- **PostgreSQL install**: if PostgreSQL is missing, the manager can offer to install PostgreSQL 18 through Windows Package Manager. This needs internet access and the normal Windows Package Manager service.
- **PostgreSQL admin password**: enter the existing PostgreSQL `postgres` password when installing, updating, or repairing the Server. The installer needs it to create/update the Riverside database user, fix permissions, and run migrations.
- **New PostgreSQL admin password**: if PostgreSQL is installed by the manager and the field is blank or placeholder, the manager generates a password and writes it to `riverside-deployment.config.json`.
- **Riverside database password**: generated automatically if left blank or still set to a placeholder. It is saved to `riverside-deployment.config.json` and written to `C:\RiversideOS\server\.env`.
- **Riverside app secret**: generated automatically if left blank, too short, or still set to a placeholder.
- **Integration credential encryption key**: written as `RIVERSIDE_CREDENTIALS_KEY` in `C:\RiversideOS\server\.env` and the Windows machine environment. This must be present before Backoffice Settings can save Helcim, QBO, Counterpoint, or other encrypted integration credentials.
- **Counterpoint bridge sync token**: generated when blank and written as `COUNTERPOINT_SYNC_TOKEN`. The same value must also be placed in `C:\counterpoint-bridge\.env` on the Counterpoint host.
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

Server, Windows app, and PWA/web files are one release. After any update, open **Settings → Updates** and confirm it shows the expected **Riverside version**. If it shows **Update incomplete**, finish the matching server or workstation update before using that station for production work.

If Riverside Settings cannot open because the API is down, manage the server from Windows instead:

1. On the Backoffice / Server PC, open the release package folder.
2. Run **`Start-RiversideDeployment.cmd`**.
3. Select **Backoffice / Server**.
4. Use **Refresh Server Status**.
5. If the package version is newer than the installed server version, run **Update This Server PC**.
6. If the server task is missing or the API is unreachable, run **Repair Server** or use **Start Server** / **Restart Server**.

Hotfix/support actions included in v0.70.0 packages:

- **`Install-RosieAiStack.cmd`** installs the ROSIE AI models and Python voice tools, patches the server `.env` to make the local LLM reachable via `RIVERSIDE_LLAMA_UPSTREAM`, and restarts the server. Use this to restore ROSIE AI features on existing Server PCs without a full reinstall.
- **`Repair-RiversideCredentialsKey.cmd`** repairs the installed server credential key, writes it to both `C:\RiversideOS\server\.env` and the Windows machine environment, and restarts the `Riverside OS Server` task. Use this when Backoffice Settings says `RIVERSIDE_CREDENTIALS_KEY` must be set before integration credentials can be saved.
- **`Set-CounterpointBridgeToken.cmd`** prompts for the exact `COUNTERPOINT_SYNC_TOKEN` from the Counterpoint bridge `.env`, writes that same token to the Riverside server environment, and restarts the server. Use this when the Counterpoint bridge reaches Riverside but fails with `health 401`.

Manual fallback:

```powershell
Copy-Item .\riverside-deployment.config.example.json .\riverside-deployment.config.json
```

Fill in:

- PostgreSQL admin/app credentials.
- `DATABASE_URL` parts through the `server.database` fields.
- `RIVERSIDE_CORS_ORIGINS` through `server.corsOrigins`.
- Store secrets in `server.environment`.
- Register #1 API base and printer settings under `register`.

Credentials may be included in this private in-store package. Do not commit the filled `riverside-deployment.config.json` to the repo.

## Backoffice / Server PC install

Preferred path:

```text
Double-click Start-RiversideDeployment.cmd and choose Backoffice / Server.
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
- Downloads the pinned ROSIE LLM model (Gemma E4B) and installs the sherpa-onnx Python voice stack.
- Writes `C:\RiversideOS\server\.env`.
- Adds the inbound firewall rule for the configured server port.
- Creates a startup scheduled task named `Riverside OS Server`.
- Starts the server and checks the local app URL.

If Riverside starts but a screen reports a missing database table, use **Apply-RiversideMigrations.cmd** from the release package. It only applies pending migrations; it does not replace the server, web bundle, or desktop app.

The Backoffice / Server desktop app also has a local recovery path: if it opens on the server PC, is pointed at `localhost` / `127.0.0.1`, and the roster check cannot reach the API, it asks Windows to start the installed `Riverside OS Server` scheduled task and then retries the roster check. If the task is missing, run **Repair** from the Deployment Manager instead of manually creating a different task name.

PostgreSQL and `psql.exe` must be installed or referenced by `server.database.psqlPath`. The Deployment Manager can find common PostgreSQL installs and write the path into the config.

API host rule:

- On the **Backoffice / Server PC**, the Riverside desktop API host should be `http://127.0.0.1:3000`.
- On **Register #1**, **Back Office Workstation**, and iPad/PWA devices, the API host should be the server PC LAN address with port 3000, for example `http://10.64.70.196:3000`.

## Register #1 install

Preferred path:

```text
Double-click Start-RiversideDeployment.cmd and choose Register #1.
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
- Tag printer mode/address/name
- Report printer mode/address/name
- Cash drawer setting

If settings changed, the app reloads once so early API calls use the installed API base.

The packaged Windows app icon should show the Riverside logo mark. A solid red square means the station is running an older placeholder-icon build and should be updated with the current register/workstation artifact.

## Back Office Workstation install

Preferred path:

```text
Double-click Start-RiversideDeployment.cmd and choose Back Office Workstation.
```

This uses the workstation installer path, writes the server API base, disables cash drawer by default, and installs the Riverside desktop app without setting up PostgreSQL or the server task.

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

For **Zebra 2844 / LP 2844 tags**, set the tag printer to the installed Zebra printer name or the Zebra network IP. Inventory tag actions send ZPL directly to that tag station; a failed hardware route must be corrected before relying on tag printing.

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
