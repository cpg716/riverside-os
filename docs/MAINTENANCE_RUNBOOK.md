# Maintenance & Operations Runbook

This guide defines the mandatory operational rhythm for the Riverside OS (ROS) server and its critical subsystems. Regular adherence to these procedures ensures long-term system stability and data integrity.

## 1. Daily Checks (Morning Routine)
Recommended for the Store Manager or Lead Cashier.

### Backup Verification
- Navigate to **Settings → Data & Backups**.
- Verify that the latest backup timestamp matches early this morning.
- Ensure the file size is non-zero (typically >1MB for a new shop, >10MB for established shops).
- **Proactive Step**: If a backup failed, use the **Immediate Backup** button. ROS will automatically attempt the **Docker-Fallback** if the host environment is unstable.

### Search Index Health
- Navigate to **Settings → Integrations → Meilisearch**.
- Verify the status is "Idle". 
- If the status is stuck at "Indexing..." for more than 1 hour without progress, check the **Bridge Logs** (Port 3002) for potential sync hangs.

---

## 2. Weekly Maintenance (EOD Sunday/Monday)
### Database Health
- Access the **Admin Command Center**.
- Trigger a **Database Vacuum** (if prompted by system warnings) to reclaim storage and optimize query performance.
- Review the `staff_access_logs` for any unexplained price overrides or remote access toggles.

### Update Check
- Check the [Riverside OS Release Board] for any urgent security patches or feature updates (v0.1.8+).
- See `docs/STORE_DEPLOYMENT_GUIDE.md` before applying updates.

---

## 3. Storage & Logs
The ROS server generates logs for three main areas:
1. **API Logs**: `server/logs/api-runtime.log`
2. **Bridge Logs**: `counterpoint-bridge/bridge-execution.log`
3. **Backup Logs**: Visible in the **Settings → Backups** history tab.

**Cleanup Rule**: ROS automatically prunes logs and local backups older than **30 days**. Ensure your **Cloud S3 Sync** is active if you require longer-term retention.

---

## 4. Emergency Procedures
### "The Bridge is Down"
If the Counterpoint sync fails:
1. Verify the **Tailscale Tunnel** is active (Settings → Remote Access).
2. Restart the Bridge process via the ROS Tray or Command Line: `cd counterpoint-bridge && npm start`.
3. Check for **Port Conflicts** (Error `EADDRINUSE: :::3002`).

### "Meilisearch Search is Blank"
1. Perform a **Full Reindex** from the Integrations panel.
2. Wait for the status indicator to return to "Idle". Search functionality is degraded during reindexing.

---
*Version: 0.1.8 - April 2026*
