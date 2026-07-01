# ROS Server Manager

`ROS-ServerManager.exe` is a separate Windows app for local Riverside OS server operations. It is intended for the Main Hub when the Riverside app cannot load because the API, database, scheduled task, or local AI host is down.

## What it checks

- Riverside OS Server scheduled task and `riverside-server.exe` process
- Local API probes for `/api/health`, `/api/ready`, `/api/live`, and `/api/version`
- PostgreSQL service, `psql.exe`, database connectivity, database size, table count, and migration count
- ROSIE `llama-server` health
- Server drive space, log size, and backup folder size
- Local deployment scripts required for repair and update actions

## Actions

- Start, stop, or restart the Riverside OS Server task
- Run the full system audit
- Apply migrations
- Repair server credentials
- Repair bootstrap admin access
- Update/reinstall server files from the deployment package
- Start or repair ROSIE
- Optimize PostgreSQL with `VACUUM ANALYZE`
- Clean old server logs and temporary installer files
- Open local server logs

Run the app as Administrator for service control, repair, update, and cleanup actions.
