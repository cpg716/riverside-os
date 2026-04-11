# Remote Access & Network Bridge Guide

This guide explains how to set up and use the built-in Tailscale Remote Access system in Riverside OS (ROS).

## Overview
Riverside OS uses **Tailscale** to create a secure, private network (Mesh VPN) between your shop's main computer (the Host) and your remote devices (Laptops, iPhones, etc.). 

**Key Benefits:**
- **Zero Configuration**: No router port forwarding or complex firewall rules.
- **Bank-Level Security**: All traffic is encrypted end-to-end via WireGuard.
- **Persistent Sync**: Keeps the Counterpoint Bridge connected even when you are off-site.

---

## 1. Setting Up the Host (Shop PC)
The computer running the main Riverside OS server is your **Host**.

1. Navigate to **Settings → Remote Access**.
2. **Setup Wizard**: If the machine is not linked, you will be guided through the **Connection Wizard**.
3. **Generate Key**: Click **Go to Tailscale Key Center** to generate an **Auth Key**.
4. **Link Machine**: Paste the key into ROS and click **Link Machine**.
5. **Verify Status**: Once connected, you will see a badge indicating your **Private Tailscale IP** (e.g., `100.x.x.x`).

![Remote Access Main Panel](file:///Users/cpg/riverside-os/client/src/assets/images/help/remote-access/panel-main.png)

---

## 2. Connecting Remote Devices (Laptops & Mobile)
To access ROS from home or on the go:

### On Desktop (Windows/Mac)
1. **Install Tailscale** from [tailscale.com](https://tailscale.com).
2. **Log in** to your company account.
3. Open your browser and type the **Shop IP** (e.g., `http://100.64.0.5:3000`).

### On Mobile (iPhone/iPad/Android)
1. Download the **Tailscale app** from the App Store or Play Store.
2. Sign in with the same account.
3. Once the tunnel is "On", use Safari or Chrome to access the ROS server at its Tailscale IP.
4. **Tip**: Add the ROS URL to your **Home Screen** for a faster App-like experience.

---

## 3. Session Safety & Emergency Disconnect
Monitoring your remote instances is critical for security.

- **Active Sessions**: The Remote Access panel shows how many devices are currently viewing the POS.
- **Emergency Disconnect**: If you suspect unauthorized access, click **Stop Remote Broadcasting**. This will immediately terminate all remote tunnels and log out active remote sessions without affecting the local shop register.

---

## 4. Troubleshooting
- **"ETIMEOUT"**: Verify that the Tailscale app is running and logged in on **both** the host and your remote device.
- **"Port 3000 Blocked"**: Ensure the host PC's firewall allows local traffic if you are using an external firewall manager.
- **Bridge Sync Failure**: If the Bridge cannot reach Counterpoint while you are remote, check the **Bridge Status Dashboard** (Port 3002) to verify it is picking up the Tailscale network interface.

---

## Security Best Practices
- **Never share your Tailscale keys**.
- **Use Multi-Factor Authentication (MFA)** on your Tailscale login account.
- **Rotate keys** every 90 days to maintain high security hygiene.

*Version: 0.1.8 - April 2026*
