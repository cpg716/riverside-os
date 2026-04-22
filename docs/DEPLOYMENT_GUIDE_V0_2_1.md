# Deployment Guide — Riverside OS v0.2.1

This guide is now a narrow overview of the **Tauri host-mode** path introduced in v0.2.1. For the full production deployment model, use **[`docs/STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md)** as the canonical reference.

## What host mode now guarantees

When you start **Shop Host** from the Windows Tauri app:

1. The desktop app resolves a real frontend bundle directory for satellite clients.
2. The embedded Axum server will not report success until that bundle path is valid and the host is actually listening.
3. The **Remote Access** panel shows the resolved bundle path, bind address, local satellite URL, and any startup failure.

This makes the dedicated Windows host + local satellite PWA path explicit and testable instead of optimistic.

## What host mode does not guarantee

- It is **not** a public-internet deployment shortcut.
- It does **not** replace the broader browser-production hardening documented in the store deployment guide.
- It does **not** ask staff to type Stripe keys into the UI. Host mode uses the environment already provisioned on the host machine.

## Host-mode setup

1. Install the Riverside desktop app on the Windows machine that should act as the host.
2. Ensure that machine has:
   - PostgreSQL reachability
   - the expected Stripe/environment configuration
   - the built frontend bundle available for the packaged app
3. Open **Settings → Remote Access**.
4. Enter the PostgreSQL URL and the listen port.
5. Start **Shop Host**.

If startup succeeds, the panel shows:

- the bind address
- the resolved frontend bundle path
- the local satellite URL for same-network devices
- the detected host LAN identity used for smoke checks
- a QR code for secondary devices

If startup fails, the panel now shows the failure directly instead of claiming the host is active.

## Satellite clients

Use the local satellite URL shown in **Settings → Remote Access** for iPads and other browser-based satellites that are on the same local network as the host machine. The panel now shows the host machine's LAN IPv4 / host name so admins can smoke-test a second device before store open. Off-site remote access is separate and still requires Tailscale. Neither path is a public-web onboarding URL.

## Related docs

- **Canonical deployment:** [`docs/STORE_DEPLOYMENT_GUIDE.md`](STORE_DEPLOYMENT_GUIDE.md)
- **PWA vs Tauri behavior:** [`docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`](PWA_AND_REGISTER_DEPLOYMENT_TASKS.md)
- **Local update protocol:** [`docs/LOCAL_UPDATE_PROTOCOL.md`](LOCAL_UPDATE_PROTOCOL.md)
