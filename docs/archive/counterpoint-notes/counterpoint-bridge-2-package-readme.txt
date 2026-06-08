Riverside OS — Counterpoint → ROS bridge (Windows package)
Bridge version: 0.7.1
Packaged: 2026-04-07T20:46Z UTC

Contents:
  - START_BRIDGE.cmd       Double-click to install deps and run
  - DISCOVER_SCHEMA.cmd   Schema probe (SQL only; no ROS token)
  - .env.example          Full template (copy to .env)
  - env.example           Same template + header (copy to .env if you prefer)
  - INSTALL_ON_COUNTERPOINT_SERVER.txt
  - README.md

First run: set SQL_CONNECTION_STRING, ROS_BASE_URL, COUNTERPOINT_SYNC_TOKEN in .env
Optional: CP_IMPORT_SINCE=2021-01-01 and __CP_IMPORT_SINCE__ in ticket/note queries.
Full runbook: docs/COUNTERPOINT_ONE_TIME_IMPORT.md (in main Riverside OS repo)
