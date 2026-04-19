# Deployment Guide — Riverside OS v0.2.1

This guide covers how to deploy Riverside OS in a professional retail environment using the new **Unified Hybrid Model**.

## 1. Environment Requirements

### Server PC (The Host)
- **OS**: Windows 10/11 (Recommended), macOS, or Linux.
- **CPU**: Intel i5 / Apple M1 or better.
- **RAM**: 8GB+ (16GB recommended if running Rosie AI).
- **Network**: Static Internal IP or Tailscale.

### Infrastructure
- **Database**: PostgreSQL 15+.
- **AI (Optional)**: If using Rosie AI, ensure `llama-server` binary is in the `binaries/` folder.

---

## 2. Installation Steps

### Step A: PostgreSQL
Install PostgreSQL and create a database:
```sql
CREATE DATABASE riverside_os;
```

### Step B: Build the Unified Bundle (On Dev Mac)
1. Build the production frontend: `cd client && npm run build`
2. Build the Tauri application: `npm run tauri:build`
3. This creates a single `.msi` (Windows) or `.dmg` (Mac).

### Step C: Deploy to High-Availability PC
1. Copy the installer to your Main PC.
2. Run the installer.
3. Launch Riverside OS.

---

## 3. Configuration

This guide is a lightweight overview only. For current production-safe environment posture, use **[`docs/STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md)** as the canonical reference.

### Hosting the Shop
On your Main PC:
1. Go to **Settings -> Network Bridge**.
2. Start the **Unified Engine**.
3. Verify that the status indicator turns **Green (Active)**.

Production browser deployments still need explicit environment hardening on the host:
- Set **`RIVERSIDE_CORS_ORIGINS`** to the exact browser origins in use.
- Set **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`** for any storefront account routes.
- Set **`FRONTEND_DIST`** explicitly for standalone/service-style hosts.
- Prefer **`RIVERSIDE_STRICT_PRODUCTION=true`** so startup rejects unsafe defaults.

### Register Setup
On all other devices:
1. Open the app or browser.
2. Direct them to the IP/DNS of the Main PC.
3. Sign in with the **Register PIN**.

---

## 4. Updates & Scaling

### Routine Updates
When a new version is released:
1. Close ROS on the Main PC.
2. Install the new version.
3. The database migrations will be handled automatically on the next launch.

### Remote Monitoring
It is recommended to use **Tailscale** for remote management. If the Shop PC is running Tailscale, you can monitor the "Engine Status" and "Status Dashboard" from anywhere in the world using your iPhone.
