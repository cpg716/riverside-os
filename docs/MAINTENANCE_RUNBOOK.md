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
- Use **Refresh** to reload the health view. Refresh does not rebuild search data.
- Verify Meilisearch is configured and the index cards are not showing failures.
- A **stale** warning means no successful rebuild or incremental update has been recorded for that index in more than 24 hours. This can be normal for quiet areas with no recent writes.
- Treat stale as actionable when search results are wrong, the store just restored/imported data, or staff recently changed records in that module and the timestamp did not move.
- If search is wrong or the service was offline during writes, run **Rebuild all indices**. Rebuild pushes PostgreSQL records back into Meilisearch and refreshes row counts.

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
1. Confirm the API host has `RIVERSIDE_MEILISEARCH_URL` set and Meilisearch is reachable.
2. Perform **Rebuild all indices** from the Meilisearch Settings panel.
3. Use **Refresh** after the rebuild response returns to reload the health view.
4. If search is still blank, confirm the relevant card has rows and no error message. SQL fallback should still keep core lookup usable while Meilisearch is unavailable.

---
*Version: 0.1.8 - April 2026*
