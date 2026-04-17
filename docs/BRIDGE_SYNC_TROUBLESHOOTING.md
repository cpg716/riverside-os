# Bridge Sync Troubleshooting Guide

The Counterpoint Bridge is the vital link between your legacy data and Riverside OS. This guide helps you diagnose and fix common synchronization issues.

## 1. Connection Resilience (The Retry Loop)
As of v0.1.8, the Bridge now includes a **20-attempt retry loop** (approx. 2.5 minutes).

- **Symptom**: The Bridge console shows `Retrying SQL connection (attempt X/20)...`
- **Cause**: The Bridge cannot reach the Counterpoint SQL server at `10.64.70.163`.
- **Resolution**:
  1. Wait for the full retry cycle. Often, the Tailscale tunnel just needs a moment to wake up.
  2. If all 20 attempts fail, the Bridge will switch to "Dashboard Only" mode. You will need to restart the Bridge once you verify the network.
---

## 2. Settings UI "Away Mode" (Failure Limit)
To prevent your browser console from filling with "Connection Refused" errors when you are away from the store, the **Settings → Integrations → Counterpoint** panel now limits connection attempts.

- **Symptom**: The "Bridge Live Status" section stops updating and shows a red "Bridge unreachable" message.
- **Cause**: The UI tried to reach the bridge 3 times and failed (Bridge PC is likely off or network is down).
- **Resolution**:
  1. Ensure the Bridge PC is on and connected to the network.
  2. Click the **[Reconnect to Bridge]** button in the ROS Settings UI. This will reset the failure counter and resume live status polling.

---
### ETIMEOUT (Connection Timed Out)
- **What it means**: The network path is blocked.
- **Troubleshooting**:
  - Verify you are logged into **Tailscale** on the host machine.
  - Ping the database server: Open Terminal and type `ping 10.64.70.163`. If no response, the shop LAN or tunnel is down.
  - Ensure the **SQL_CONNECTION_STRING** in `counterpoint-bridge/.env` is correct.

### EADDRINUSE (Address Already in Use)
- **What it means**: Another Bridge process is already running on Port 3002.
- **Resolution**:
  - Close any existing terminal windows running the Bridge.
  - In ROS, go to **Operations → Systems** and click **Restart Sync Bridge**.

---

## 3. Data Sync Hangs
If a specific entity (e.g., `inventory` or `tickets`) gets stuck:

1. **Check the Dashboard**: Open `http://localhost:3002` on the shop PC.
2. **Review Logs**: Look for "slow statement" warnings. High-volume migrations (v8.2 Counterpoint) can take several minutes per entity.
3. **Manual Trigger**: Use the **Trigger Sync** buttons on the dashboard to restart a specific entity pass.

---

## 4. Bridge Environment Secrets
Ensure these values in `counterpoint-bridge/.env` are intact:
- `ROS_BASE_URL`: Should be `http://127.0.0.1:3000` (local) or your Tailscale IP (remote).
- `COUNTERPOINT_SYNC_TOKEN`: Must match the server secret.
- `SQL_REQUEST_TIMEOUT_MS`: Default is `600000` (10 minutes). Increase this if you are syncing more than 50k tickets.

---
*Version: 0.1.8 - April 2026*
