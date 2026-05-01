# Riverside OS Windows installer package

This package is the near-turnkey deployment path for the in-store Windows machines:

- **Backoffice / Server PC**: PostgreSQL database, Riverside server, web bundle, migrations, firewall rule, and startup task.
- **Register #1**: Riverside desktop app, station API base, printer target, and cash drawer setting.

The package intentionally keeps a readable JSON config next to the installers so the store-specific values are visible before install.

## Package layout

Build output:

```text
RiversideOS-v0.4.0-Windows-Deployment/
  install-server.ps1
  install-register.ps1
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
.\deployment\windows\build-deployment-package.ps1 -Version "0.4.0"
```

If the Tauri register bundle is coming from GitHub Actions instead of the local machine, copy the downloaded MSI into the package's `register/` folder before running `install-register.ps1`.

## Configure the package

Copy:

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

Run PowerShell as Administrator:

```powershell
.\install-server.ps1
```

The script:

- Creates `C:\RiversideOS` folders.
- Copies `riverside-server.exe`.
- Copies `client-dist`.
- Copies migrations.
- Copies bundled docs into `C:\RiversideOS\release\docs` for help/reindex workflows when enabled.
- Creates/updates the PostgreSQL app role and database.
- Applies pending migrations using `psql`.
- Writes `C:\RiversideOS\server\.env`.
- Adds the inbound firewall rule for the configured server port.
- Creates a startup scheduled task named `Riverside OS Server`.
- Starts the server and checks the local app URL.

PostgreSQL 16 and `psql.exe` must be installed or referenced by `server.database.psqlPath`.

## Register #1 install

Run PowerShell as Administrator:

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

## Remaining manual smoke

The package gets the machines close to ready, but still verify:

- Server loads from another device.
- Register #1 can sign in and open the till.
- Receipt test prints.
- Cash drawer opens for cash/check.
- Scanner input reaches POS search.
- One supervised sale or dry-run path is completed.
