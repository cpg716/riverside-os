# Remote Access Guide — Riverside OS

This is the canonical technical reference for off-site remote access to Riverside OS using **Tailscale**. It covers both the one-time infrastructure setup (IT / operator role) and the per-device setup (staff role).

**Audience:** Store owner, IT, and any staff who need off-site access.  
**Related:** [`REMOTE_ACCESS_USER_GUIDE.md`](REMOTE_ACCESS_USER_GUIDE.md) (concept overview), [`STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md) (full deployment), [`PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md) (client deployment checklist).

---

## 1. Why Tailscale

Riverside OS runs on your own Windows **Main Hub** at the store. It is **not** a cloud service. To reach it from outside the shop network, you need a secure private tunnel — Tailscale provides this with zero open ports on your internet router and no VPN configuration overhead.

| Tailscale gives you | Notes |
|---|---|
| A stable private IP (`100.x.x.x`) for each device | Works across NAT, mobile networks, Wi-Fi |
| MagicDNS hostnames (e.g. `ros-server.ts.net`) | Optional but recommended for HTTPS |
| End-to-end WireGuard encryption | No traffic passes through Tailscale's servers |
| Per-device auth; revoke any device instantly | From the Tailscale admin console |

**You do not need to open any router ports or configure NAT** when using Tailscale.

---

## 2. One-time Main Hub setup (IT / owner — done once)

### 2.1 Install Tailscale on the Main Hub

1. Download the Windows installer from [tailscale.com/download](https://tailscale.com/download).
2. Install and sign in with your Tailscale account (create one free at [login.tailscale.com](https://login.tailscale.com) — use your store Google account or email).
3. The Main Hub appears in your Tailscale admin console at [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines).
4. Note the Main Hub's **Tailscale IP** (`100.x.x.x`) and optionally its **MagicDNS name** (e.g. `ros-server.tail12345.ts.net`).

### 2.2 Windows Firewall — allow inbound on the Tailscale interface

Riverside listens on `0.0.0.0:3000` by default. You want to allow inbound connections from Tailscale IPs but **not** from the public internet.

Run in an elevated PowerShell on the Main Hub:

```powershell
# Allow Riverside on the Tailscale network interface (100.x.x.x range)
New-NetFirewallRule `
  -DisplayName "Riverside OS - Tailscale" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 3000 `
  -RemoteAddress "100.64.0.0/10" `
  -Action Allow
```

> The `100.64.0.0/10` CIDR covers all Tailscale device IPs. If you want to restrict further, list specific `100.x.x.x` addresses for known staff devices.

Also confirm the existing LAN firewall rule is scoped to your store subnet (not `Any`):

```powershell
# View existing Riverside firewall rules
Get-NetFirewallRule -DisplayName "Riverside*" | Get-NetFirewallAddressFilter
```

### 2.3 CORS — allow the Tailscale origin

When staff access Riverside from a browser or PWA over Tailscale, the browser enforces CORS. The server must allow those origins.

Add to the Main Hub `.env` (or Windows Machine environment):

```
RIVERSIDE_STRICT_PRODUCTION=true
RIVERSIDE_CORS_ORIGINS=http://100.x.y.z:3000,https://ros-server.tail12345.ts.net
```

- Replace `100.x.y.z` with the Main Hub's actual Tailscale IP.
- Replace the MagicDNS name with yours from the Tailscale admin console.
- List **every** origin staff browsers will use, separated by commas.
- `RIVERSIDE_STRICT_PRODUCTION=true` causes the server to refuse to start if CORS is misconfigured — use this in production.

Restart the `"Riverside OS Server"` scheduled task after changing `.env`.

### 2.4 Optional: HTTPS with Tailscale Serve

For HTTPS without a reverse proxy, use **Tailscale Serve** on the Main Hub:

```powershell
# Expose Riverside on https://ros-server.tail12345.ts.net (port 443)
tailscale serve --bg http://localhost:3000
```

This terminates TLS at the Tailscale daemon and forwards to the local Riverside server. Staff then connect to `https://ros-server.tail12345.ts.net` — no certificate warnings, no port numbers.

Update `RIVERSIDE_CORS_ORIGINS` to use the HTTPS MagicDNS origin when using Tailscale Serve.

---

## 3. Per-device setup (staff — one-time per device)

### 3.1 Windows laptop or desktop

1. Download Tailscale from [tailscale.com/download/windows](https://tailscale.com/download/windows).
2. Install and sign in with the **same Tailscale account** as the Main Hub.
3. The device joins your private network automatically.
4. Open Riverside → Server Connection → **Tailscale / Remote Address → Set** → enter the server's Tailscale address (e.g. `http://100.x.y.z:3000` or `https://ros-server.tail12345.ts.net`).
5. Save. The address appears as **"Store server (Tailscale / remote)"** in the quick-pick list.

> Tailscale runs as a Windows background service after install. It reconnects automatically on boot and network changes.

### 3.2 macOS laptop

1. Install from the Mac App Store: search **Tailscale** or visit [tailscale.com/download/mac](https://tailscale.com/download/mac).
2. Sign in with your store Tailscale account.
3. Follow step 4–5 from the Windows instructions above in the Riverside sign-in gate.

### 3.3 iPad / iPhone

1. Install **Tailscale** from the App Store.
2. Sign in with your store Tailscale account.
3. In Tailscale, tap the toggle next to your network to connect.
4. In Riverside (PWA / browser), open **Server Connection → Tailscale / Remote Address → Set** → enter the server's Tailscale address.

> On iOS, Tailscale uses a local VPN profile. You may need to approve the VPN configuration during first setup.

### 3.4 Android phone or tablet

1. Install **Tailscale** from the Google Play Store.
2. Sign in and connect.
3. Same step 4–5 from the Windows instructions.

---

## 4. In-app Tailscale integration (Riverside sign-in gate)

As of v0.80.9, the Riverside sign-in gate has built-in Tailscale support:

- **Tailscale / Remote Address saver** — in Server Connection, tap **Set** to save your store's Tailscale address. It is stored per-device and appears as a named quick-pick on every subsequent launch.
- **Remote Tailscale Session badge** — when Riverside detects you are accessing it from a Tailscale IP or `.ts.net` hostname, a purple "Remote Tailscale Session" badge shows at the bottom of the sign-in card.
- **Connection failure hint** — if the active server URL looks like a Tailscale address but the server is unreachable, an indigo warning banner appears: *"Make sure the Tailscale app is running and connected on this device."*

---

## 5. Day-to-day use

### Switching between in-store and remote

In the Riverside sign-in gate, open **Server Connection (Change)**:

- **In-store:** select "Current saved host" or the LAN IP quick-pick.
- **Off-site:** select "Store server (Tailscale / remote)".

Tailscale must be **connected** on the device before switching to the remote address.

### Verifying Tailscale is connected

- **Windows / macOS:** the Tailscale icon in the system tray shows a green dot when connected.
- **iOS / Android:** the Tailscale app shows "Connected" and a VPN icon appears in the status bar.
- **All platforms:** `ping 100.x.y.z` (the server's Tailscale IP) from a terminal should reply.

---

## 6. Admin console — managing devices

Log in at [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines) to:

- **See all connected devices** and their Tailscale IPs.
- **Disable or remove** a device (e.g. a lost phone) instantly — it loses access immediately.
- **Rename devices** for clarity (e.g. "ROS Main Hub", "Owner iPhone").
- **Set key expiry** — by default device keys expire after 90 days and require re-authentication; disable expiry for always-on machines like the Main Hub.

### Disabling key expiry on the Main Hub (recommended)

In the admin console → Machines → click the Main Hub → **Disable key expiry**. This prevents the server from dropping off the Tailscale network after 90 days without requiring a manual re-login.

---

## 7. Security notes

- **Enable MFA** on the Tailscale account (admin console → Settings → Auth).
- **Do not share Tailscale auth keys** casually — each device should authenticate individually.
- **Revoke devices immediately** when a staff member leaves or a device is lost.
- **Do not** set `RIVERSIDE_CORS_ORIGINS` to `*` in production — always list specific origins.
- Disconnecting Tailscale on a device removes that device's remote access; it does not affect in-store LAN access.
- The Tailscale connection is end-to-end encrypted (WireGuard). Tailscale's relay servers only carry encrypted packets and cannot read your data.

---

## 8. Troubleshooting

| Symptom | Check first | Then |
|---|---|---|
| Cannot reach server over Tailscale | Is Tailscale running and connected on **both** devices? | Check Main Hub system tray; check remote device Tailscale app |
| Sign-in gate shows connection failed hint | Tailscale not connected on this device | Open Tailscale app and connect, then retry |
| `CORS` error in browser console | `RIVERSIDE_CORS_ORIGINS` missing this device's origin | Add origin to `.env`, restart server |
| Main Hub dropped off Tailscale network | Key expired (90-day default) | Re-login on Main Hub or disable key expiry in admin console |
| MagicDNS name not resolving | MagicDNS not enabled in Tailscale admin | Admin console → DNS → Enable MagicDNS |
| HTTPS cert warning | Not using Tailscale Serve | Set up `tailscale serve` on the Main Hub (section 2.4) |
| Tailscale down, need emergency access | Use LAN IP if on the same network | If off-site and Tailscale is down, no remote access until restored |

---

## 9. Quick reference

| Item | Where to find it |
|---|---|
| Main Hub Tailscale IP | Tailscale admin console → Machines, or hover tray icon |
| Main Hub MagicDNS name | Admin console → Machines → click PC |
| Tailscale admin console | [login.tailscale.com/admin](https://login.tailscale.com/admin) |
| Riverside Tailscale address field | Sign-in gate → Server Connection → Tailscale / Remote Address → Set |
| CORS env var | `RIVERSIDE_CORS_ORIGINS` in server `.env` |
| Firewall rule | `New-NetFirewallRule` (section 2.2) |

---

*Last updated: 2026-07-01. Reflects Riverside OS v0.90.0 Main Hub terminology, in-app Tailscale address saver, and bounded sign-in connection recovery.*
