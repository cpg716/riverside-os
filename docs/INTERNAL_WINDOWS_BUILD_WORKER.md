# Internal Windows Build Worker

Riverside OS uses the Mac as the primary development machine and the Main Hub Windows PC as the private Windows build, signing, promotion, and update host. This lane transfers committed source directly over the store LAN or Tailscale, performs Windows-native validation and packaging outside the live installation, and can explicitly promote the verified result without a hosted source or release service.

GitHub is not part of this source-transfer or build-control path.

## Safety boundary

The build worker:

- accepts only a clean, committed `HEAD` from the Mac;
- transfers a `git archive`, so no GitHub checkout or remote fetch is required;
- builds under `C:\ProgramData\RiversideOS\build-worker`, never under the live `C:\RiversideOS` installation;
- runs at below-normal process priority;
- refuses to run from 10 AM through 6 PM unless the operator explicitly passes `-AllowStoreHours`;
- requires at least 35 GB of free disk space;
- requires the live Main Hub `/api/ready` check before the build and again afterward;
- serializes jobs with an exclusive build lock;
- never installs or changes production during `Validate` or `Package`; production changes require the separate explicit `-Promote` switch;
- records the exact 40-character source SHA, worker identity, validation result, Main Hub readiness, artifact hashes, and certification boundary in `windows-build-summary.json`.

`Package` produces an exact-build Main Hub ZIP, a Tauri-signed Windows updater artifact, `release.json`, the public updater key, hashes, and build evidence. The private updater key is generated once on Main Hub, encrypted for the existing Windows account with Windows DPAPI, and never copied to the Mac. The candidate summary remains `productionReady: false` until explicit promotion installs the Main Hub package and passes exact-build readiness. Physical hardware checks remain an operator responsibility.

## Main Hub prerequisites

Use the existing Windows account that normally administers the Main Hub. A separate build account is optional and is not required for a privately operated Main Hub. Do not store the Windows password in the repository or in command-line arguments.

The Main Hub needs:

- Windows OpenSSH Server reachable from the Mac over the chosen LAN or Tailscale address;
- Node.js 24 (`node.exe`, `npm.cmd`, and `npx.cmd`);
- rustup with Rust 1.91, `rustfmt`, and `clippy`;
- Visual Studio 2022 Build Tools with the Desktop development with C++ workload and Windows SDK;
- sufficient disk and memory to compile without affecting store operations.

Initialize the current Windows account's build directories from an elevated Main Hub PowerShell window:

```powershell
.\deployment\windows\Initialize-RiversideWindowsBuildWorker.ps1
```

The initializer defaults to `$env:USERDOMAIN\$env:USERNAME`. It does not create an account, install toolchains, enable OpenSSH Server, or broaden the firewall. It grants the existing account access to the isolated worker directory, installs the fixed elevated **Riverside OS Internal Release Promotion** scheduled task, then requires the Windows `sshd` service to already be running. Use the configured SSH key; no Riverside command accepts or stores the Windows account password.

Tauri updater signing is automatic on the first package build. If Riverside later obtains a real Windows code-signing certificate, configure its existing certificate-store thumbprint while rerunning the initializer:

```powershell
.\deployment\windows\Initialize-RiversideWindowsBuildWorker.ps1 `
  -AuthenticodeCertificateThumbprint "40-CHARACTER-CERTIFICATE-THUMBPRINT"
```

This is optional for the private updater integrity contract. It is required for Windows publisher trust. Do not use a self-signed certificate as a substitute.

The first `Package` request may also need network access for pinned Windows build inputs and ordinary npm/Cargo dependencies. Pass `-AllowExternalDownloads` for that bootstrap build. The worker verifies the pinned llama.cpp, WiX, ROSIE speech-runtime, and Meilisearch downloads by SHA-256 and retains them under its private cache. Later package builds reuse those verified copies. A fully offline npm/Cargo mirror is a separate hardening step.

## Run from the Mac

The Mac SSH configuration provides `riverside-main-hub` for direct LAN access and `riverside-main-hub-tailscale` for remote access. Select the route for the current connection:

```bash
export ROS_MAIN_HUB_HOST="riverside-main-hub"
```

SSH uses the dedicated Mac-side key at `~/.ssh/riverside_main_hub_build`; the SSH aliases select it automatically. The build script does not accept or persist a plaintext password parameter.

Run Windows-native validation:

```bash
npm run build:windows:remote -- -Task Validate
```

Create an exact-build Windows/Main Hub candidate after the runtime cache is populated:

```bash
npm run build:windows:remote -- -Task Package
```

Build, install on Main Hub, verify the exact release, and publish it to the private workstation feed:

```bash
npm run release:internal:windows
```

The release command requires a clean committed `HEAD`. During store hours it stops before building or installing unless `-- -AllowStoreHours` is explicitly added. Use the Tailscale route when away from the store:

```bash
npm run release:internal:windows -- -MainHubHost riverside-main-hub-tailscale
```

Allow the first package build to retrieve missing pinned inputs:

```bash
npm run build:windows:remote -- -Task Package -AllowExternalDownloads
```

To select a route explicitly:

```bash
npm run build:windows:remote -- -MainHubHost "riverside-main-hub" -Task Validate
npm run build:windows:remote -- -MainHubHost "riverside-main-hub-tailscale" -Task Validate
```

Use `-AllowStoreHours` only after confirming that compilation load cannot interfere with Register or Main Hub service. Use `-KeepRemoteSource` only for a specific build investigation; normal jobs remove their temporary source and inbox copy while retaining remote artifact evidence.

## Tasks and outputs

### `Validate`

Runs on Windows:

- deployment PowerShell parsing;
- version-parity and deployment-release contracts;
- client lint and TypeScript checks;
- Rust formatting and workspace compilation checks.

### `Package`

Runs all `Validate` work, then:

- builds the Windows release server;
- builds the Windows Tauri installer/updater bundle with the pinned Windows llama.cpp sidecar;
- signs the updater with the DPAPI-protected private Main Hub key;
- assembles the exact-build `MainHub-Update.zip` with the normal package checksum manifest;
- writes the private `release.json` contract and copies the artifacts, transcript, and summary back to the Mac.

Mac-side artifacts are written beneath:

```text
dist/internal-windows-builds/<timestamp>-<sha>-<task>/
```

Windows-side evidence remains beneath:

```text
C:\ProgramData\RiversideOS\build-worker\artifacts\<timestamp>-<sha>-<task>\
```

## Guarded promotion and rollback

A successful build is not a deployment. `-Promote` is a separate explicit action. It starts the fixed elevated Main Hub task, which:

1. validates `release.json`, the exact 40-character source SHA, byte counts, package SHA-256, and updater SHA-256;
2. runs the normal checksummed `install-server.ps1`, including the required verified pre-migration PostgreSQL backup and its built-in file/task/config rollback;
3. updates the Main Hub desktop app with the same package;
4. requires `/api/ready` to report the expected build, connected database, and authoritative search;
5. only then atomically makes the new internal release feed current, retaining the previous feed.

If installation or readiness fails, the new feed is not published. The prior feed stays current, and the normal server installer rollback is authoritative. Promotion status is written under `C:\ProgramData\RiversideOS\build-worker\promotion`. Once promoted, Windows stations use **Settings → Updates → Install update**; the signed artifact comes from the Main Hub address already stored in that station's configuration.

The internal read-only feed is served at:

```text
/api/internal-updates/windows/latest.json
/api/internal-updates/release.json
/api/internal-updates/files/<verified-asset>
```

Plain HTTP updater transport is accepted only for loopback, private LAN, Tailscale CGNAT, `.local`, single-label, or `.ts.net` Main Hub addresses. Tauri signature verification remains mandatory. HTTPS also works when configured.

## Remaining operator proof

The automated promotion proves source identity, package integrity, backup/rollback execution, server/database/search readiness, and updater signature. Before calling a substantial release fully store-certified, still perform the release's targeted Playwright coverage and real Register printer, scanner, cash-drawer, payment-terminal, and updater smoke checks when those areas changed.

## Troubleshooting

- **Dirty worktree:** commit the intended source first. Uncommitted Mac files are never silently omitted from a Windows build.
- **Connection failure:** verify that the selected LAN or Tailscale address reaches the Main Hub OpenSSH endpoint and that the build-worker account or SSH key is valid.
- **Store-hours refusal:** wait for the safe window or explicitly authorize `-AllowStoreHours` after checking live operations.
- **Main Hub readiness refusal:** repair the live service first. The production host is not used for compilation while it is already degraded.
- **Missing pinned runtime:** rerun the first package build with `-AllowExternalDownloads`; a checksum mismatch fails closed.
- **Failed build:** inspect `windows-build.log` and `windows-build-summary.json` copied to the Mac. A failed job does not install its output.
- **Promotion task missing:** rerun `Initialize-RiversideWindowsBuildWorker.ps1` from elevated Main Hub PowerShell once after installing this phase.
- **Promotion failed:** inspect `promotion-status.json` and the job's `promotion-transcript.txt`; the previous workstation feed remains current.
- **Windows publisher warning:** updater integrity is protected by the Tauri signature, but Windows publisher reputation additionally requires a valid Authenticode certificate configured by thumbprint.
