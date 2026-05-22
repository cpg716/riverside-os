# ROS Dev Center

Standalone macOS DevOps companion app for Riverside OS.

## What It Does

- **Connects to any ROS instance** — local (`localhost:3000`) or remote via Tailscale
- **Real-time monitoring** — DB health, stations, alerts, bugs
- **GitHub integration** — view workflow runs, releases, trigger builds
- **One-click release builds** — dispatch the Tauri updater release workflow

## Setup

```bash
cd ros-dev
npm install
```

## Development

```bash
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Connect to ROS

1. Launch the app
2. Enter your ROS server URL (e.g., `http://localhost:3000` or `http://riverside-server:3000` over Tailscale)
3. Enter your staff PIN
4. The DevOps dashboard loads automatically

## Requirements

- macOS 13+ (optimized for Apple Silicon)
- ROS server with `ops.dev_center.view` permission for your staff PIN
- For GitHub features: `RIVERSIDE_GITHUB_TOKEN` must be set on the ROS server
