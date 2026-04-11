# Security Architecture & Data Protection

Riverside OS (ROS) is designed with a "Local-First, Security-Deep" philosophy. This document outlines the technical security measures implemented to protect store data, customer PII, and financial records.

## 1. Physical & Network Sovereignty
ROS operates on a **Local-First** model. Unlike traditional SaaS POS systems, your data is not stored on a third-party multi-tenant cloud. 

### Zero-Trust Networking (Tailscale)
- **No Open Ports**: ROS does not require port forwarding or DMZ configurations. The host remains invisible to the public internet.
- **Encrypted Tunnels**: All remote traffic is encapsulated in **WireGuard** (ChaCha20-Poly1305) tunnels via Tailscale.
- **Node Authorization**: Only devices authenticated with your company's SSO/MFA-protected Tailscale account can discover or communicate with the ROS server.
- **Isolation**: Remote access can be physically terminated via the **Emergency Logout** feature, which shuts down the local tunnel interface instantly.

## 2. Application Layer Security
The ROS backend is engineered for resilience and memory safety.

### Memory Safety (Rust)
- Built entirely in **Rust**, eliminating common vulnerabilities such as buffer overflows, use-after-free, and null pointer dereferences.
- Compiled as a static binary with minimal dependencies to reduce the attack surface.

### Credential Hardening
- **PIN Hashing**: Staff PINs are never stored in plain text. We utilize modern cryptographic hashing (Argon2id/Bcrypt) to secure credentials in the local database.
- **Local-Only Auth**: Authentication is performed locally on your shop's hardware. No third-party "Identity Provider" has access to your staff credentials.

### Process Isolation (Tauri)
- The desktop/host interface uses **Tauri**, which isolates the window rendering process from the system's core capabilities.
- Inter-process communication (IPC) is restricted via a strict allow-list of commands.

## 3. Data Protection
### Storage & Encryption
- **Local Database**: All primary records reside in a local PostgreSQL instance.
- **Docker-Fallback Backups**: If the host tool fails, ROS uses an internal containerized backup engine to ensure data capture.
- **Encrypted Cloud Backups**: Backup snapshots are compressed and encrypted before being transmitted to off-site S3 storage.

### Audit Logging
- ROS maintains an internal `staff_access_logs` table that records high-impact actions (price overrides, manual inventory adjustments, remote access toggles) along with the performing Staff ID and timestamp.

## 4. Authentication & Authorization
### RBAC (Role-Based Access Control)
- ROS uses a granular permission system (e.g., `settings.admin`, `pos.price_override`, `customers.view`).
- Permissions are enforced at the API handler level; a valid Staff Code and hashed PIN verification are required for every state-changing request.

## 5. Security Best Practices for Operators
1. **Enable MFA**: Always enable Multi-Factor Authentication on the Google/Microsoft account associated with your Tailscale network.
2. **Physical Lock**: Ensure the shop's Host PC is physically secured and requires a password to wake from sleep.
3. **Audit Regularly**: Frequently review the "Staff Access Logs" in the Admin panel to monitor for unusual activity.
4. **Key Rotation**: Rotate your `COUNTERPOINT_SYNC_TOKEN` and Tailscale Join Keys every 90 days.

---
*Version: 0.1.8 - April 2026*
