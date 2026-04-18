# Unified Engine & Shop Host Mode (v0.2.1+)

Riverside OS v0.2.1 introduces the **Unified Hybrid Architecture**, which merges the standalone Backend Server (Rust Axum) into the Tauri Desktop App. This allows a single application to serve as both the client register and the primary shop "Host" (Server).

## Why Unified?

Prior to v0.2.1, updating the shop required two separate steps:
1. Updating the Register App (Tauri).
2. Manually updating the Server Engine (running `git pull` or replacing a binary).

With the **Unified Engine**, the Server PC simply runs the Tauri app. When the app updates itself via the built-in ROS updater, it updates the **Engine** simultaneously, ensuring the database schema and API logic are always in lockstep with the UI.

---

## Architecture Overview

In a multi-register shop, the application operates in one of two modes:

### 1. Host Mode (The Server PC)
One machine in the shop (usually a powerful Windows PC in the back office) acts as the **Host**.
- **Engine**: The app spawns a background thread running the Axum web server on port `3000`.
- **Workers**: All background tasks (QBO sync, Automated Messaging, Daily Backups, Weather Snapshots) run on this machine.
- **Database**: This machine is physically connected to the PostgreSQL database.

### 2. Register Mode (The Satellites)
All other registers (iPads, Windows registers, Laptops) run the **same app** but connect to the Host.
- **Engine**: The local engine is **OFF**.
- **Connectivity**: These apps connect to the Host's IP address (e.g., `192.168.1.50` or the Tailscale MagicDNS).

---

## Configuration & Setup

### Enabling Host Mode
1. Open Riverside OS on your **Main Server PC**.
2. Navigate to **Settings** -> **Network Bridge**.
3. Toggle **"Enable Shop Host Mode"** to ON.
4. Enter your configuration:
   - **PostgreSQL URL**: `postgres://user:password@localhost/riverside_os`
   - **Listen Port**: `3000` (Default)
5. Click **"Start Unified Engine"**.

### Connecting Registers
1. Open Riverside OS on any device.
2. If prompted, enter the IP or MagicDNS of the Host PC.
3. The app will verify the connection and instantly sync all catalog and transaction data.

---

## Operations & Maintenance

### Updates
When a developer pushes an update:
1. The **Host PC** will notify of an update. Click **Reload Now**.
2. The Host PC updates, restarts, and brings the **new Engine** online automatically.
3. The **Registers** will then prompt for their own updates. Once updated, they reconnect to the new Engine seamlessly.

### Migrations
Database migrations are handled automatically by the Unified Engine on startup. You do not need to run SQL manually.

### Failover (The "Spare Tire" Strategy)
If your Main Server PC fails:
1. Go to any other Windows register that has the ROS app installed.
2. In the Network Bridge settings, toggle **Host Mode** to ON.
3. Point it to your database (assuming it's on a shared drive or has a recent backup).
4. This register is now the new Shop Host. All iPads will instantly reconnect once you give them the new IP.
