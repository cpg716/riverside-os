# Riverside Countersync Bridge GUI

Tauri desktop control panel for the Counterpoint SQL → Riverside OS migration bridge.

## Runtime behavior

- The packaged bridge files are copied into the app data directory on first launch.
- Packaged Windows releases include a Node runtime and production bridge dependencies, so operators do not need to install Node.js or run `npm install`.
- The operator `.env` file and cursor state live in that writable app data bridge folder.
- App updates refresh bundled bridge files when packaged files or dependency manifests change, while preserving `.env`.
- Development builds may still use the system `node`/`npm` fallback when bundled runtime resources are not present.
- The GUI does not auto-start the bridge until the SQL connection and Main Hub SYNC Workbench URL are configured.

## Operator flow

1. Open the GUI on the Counterpoint host or a machine with SQL Server access.
2. Enter the Counterpoint SQL connection string and Main Hub SYNC Workbench URL. From the Counterpoint PC, this must be the Main Hub LAN address, such as `http://10.64.70.196:3015`; `127.0.0.1` points back to the Counterpoint PC.
3. Save configuration.
4. Start with Dry Run enabled and review the Process Console.
5. Open the Counterpoint SYNC Workbench from the sidebar and verify received runs before ROS final import.

Loyalty is snapshot-only for go-live: current balances come through the customer import as `pts_bal`; ROS manages points after cutover.
