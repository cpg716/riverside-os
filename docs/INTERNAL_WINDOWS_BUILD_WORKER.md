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

The initializer defaults to the existing machine-local `$env:COMPUTERNAME\$env:USERNAME` account. Pass `-BuildWorkerUser` explicitly only when Main Hub intentionally uses a domain account. It does not create an account, install toolchains, enable OpenSSH Server, or broaden the firewall. It grants the existing account access to the isolated worker directory, installs the fixed elevated **Riverside OS Internal Release Promotion** scheduled task, then requires the Windows `sshd` service to already be running. Use the configured SSH key; no Riverside command accepts or stores the Windows account password.

Tauri updater signing is automatic on the first package build. If Riverside later obtains a real Windows code-signing certificate, configure its existing certificate-store thumbprint while rerunning the initializer:

```powershell
.\deployment\windows\Initialize-RiversideWindowsBuildWorker.ps1 `
  -AuthenticodeCertificateThumbprint "40-CHARACTER-CERTIFICATE-THUMBPRINT"
```

This is optional for the private updater integrity contract. It is required for Windows publisher trust. Do not use a self-signed certificate as a substitute.

The first `Package` request may also need network access for pinned Windows build inputs and ordinary npm/Cargo dependencies. Pass `-AllowExternalDownloads` for that bootstrap build. The worker verifies the pinned llama.cpp, WiX, ROSIE speech-runtime, and Meilisearch downloads by SHA-256 and retains them under its private cache. Later package builds reuse those verified copies. A fully offline npm/Cargo mirror is a separate hardening step.

## Preferred candidate-only procedure

Use this sequence whenever the goal is to create a new Windows candidate without changing the live Main Hub or any workstation. GitHub, a push, a tag, and a hosted release are not required.

### 1. Prepare one exact source commit on the Mac

From the Riverside OS repository:

```bash
cd /Users/cpg/riverside-os
git status --short
git rev-parse HEAD
```

`git status --short` must print nothing. Validate, document, stage, and commit only the intended work before continuing. The build lane transfers `git archive HEAD`; uncommitted and untracked files are deliberately excluded. A GitHub push is not required.

Record the 40-character SHA printed by `git rev-parse HEAD`. That is the source identity the Windows worker must report.

### 2. Select the Main Hub route

Use direct LAN while connected to the store network:

```bash
export ROS_MAIN_HUB_HOST="riverside-main-hub"
```

Use Tailscale only when building remotely:

```bash
export ROS_MAIN_HUB_HOST="riverside-main-hub-tailscale"
```

Choose the route that will remain reachable for the complete build and promotion. If the Mac may leave the store network before the command finishes, select Tailscale before starting. An established LAN SSH connection cannot migrate to Tailscale mid-command; the isolated Windows build can still finish, but the Mac cannot retrieve its evidence or request promotion through the broken LAN socket.

The SSH alias selects the dedicated key. Do not put a Windows password, signing key, token, or other secret in the command, repository, logs, or documentation.

### 3. Request the candidate

For an initialized worker with populated caches, this is the normal command:

```bash
npm run build:windows:remote -- -Task Package
```

Add only the exception switches that are actually required:

```bash
# Permit the bootstrap build to retrieve missing pinned/runtime inputs.
npm run build:windows:remote -- -Task Package -AllowExternalDownloads

# Permit a build during the protected 10 AM through 6 PM window, but only
# after confirming that compilation load will not disrupt store operations.
npm run build:windows:remote -- -Task Package -AllowStoreHours

# Bootstrap during the protected window when both exceptions are intentional.
npm run build:windows:remote -- -Task Package -AllowStoreHours -AllowExternalDownloads
```

Do **not** add `-Promote` when the request is only to build a candidate. Keep the command attached until it exits. Optimized Rust linking, Tauri bundling, copying Cube Core, verifying the package manifest, and ZIP compression can each be silent for several minutes; silence alone is not a hung build. Do not start a second build while the first job is still running.

### 4. Require successful completion evidence

A successful command ends with both messages:

```text
Windows build evidence copied to: <local-candidate-directory>
Windows Package task completed for <40-character-source-sha>.
```

Use the exact local directory printed by the command for the remaining checks. It will normally be:

```text
dist/internal-windows-builds/<timestamp>-<8-character-sha>-package/
```

If the command exits nonzero, the candidate is not acceptable. Inspect the copied `windows-build.log` and `windows-build-summary.json`; do not install partial artifacts. The worker retains its evidence under `C:\ProgramData\RiversideOS\build-worker\artifacts\<job-id>\` even though normal jobs remove their temporary source tree.

### 5. Verify the exact candidate on the Mac

Set `candidate_dir` to the exact directory printed by the build, then require the candidate gate and unchanged live Main Hub:

```bash
candidate_dir="dist/internal-windows-builds/<job-id>"
head_sha="$(git rev-parse HEAD)"

jq -e --arg sha "$head_sha" '
  .status == "succeeded" and
  .sourceGitSha == $sha and
  .releaseCandidateReady == true and
  .internalUpdaterSigned == true and
  .productionReady == false and
  .mainHubBefore.reachable == true and
  .mainHubBefore.ready == true and
  .mainHubAfter.reachable == true and
  .mainHubAfter.ready == true and
  .mainHubBefore.buildSha == .mainHubAfter.buildSha
' "$candidate_dir/windows-build-summary.json"

jq -e --arg sha "$head_sha" '
  .sourceGitSha == $sha and
  (.mainHubPackage.fileName | endswith("-MainHub-Update.zip")) and
  (.windowsUpdater.fileName | endswith("-setup.exe")) and
  (.windowsUpdater.signature | length > 0)
' "$candidate_dir/release.json"
```

Then verify every copied artifact against the worker summary:

```bash
jq -r '.artifacts[] | [.name, .sha256] | @tsv' \
  "$candidate_dir/windows-build-summary.json" |
while IFS=$'\t' read -r name expected; do
  actual="$(shasum -a 256 "$candidate_dir/$name" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 mismatch: $name" >&2
    exit 1
  fi
  echo "OK $name"
done
```

All rows must print `OK`. Keep the entire candidate directory together: the installer, updater signature, Main Hub ZIP, public updater key, `release.json`, summary, and transcript are one evidence set. Do not add generated candidate artifacts under `dist/` to Git.

### 6. Report the boundary accurately

At candidate completion, report:

- the exact 40-character source SHA and candidate directory;
- `status: succeeded`, `releaseCandidateReady: true`, and `internalUpdaterSigned: true`;
- the Main Hub ZIP and Windows updater filenames;
- that all copied SHA-256 values matched;
- that Main Hub readiness passed before and after and its live build SHA did not change;
- that nothing was installed, promoted, pushed, tagged, or published.

`productionReady: false` is correct for a candidate-only run. `authenticodeVerified: false` is also expected unless Riverside has configured a valid Windows code-signing certificate; the internal Tauri signature still protects updater integrity, but it does not provide Windows publisher reputation.

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

This supported activation path starts a fresh exact-`HEAD` `Package` job and promotes it only after the candidate gate passes. It does not silently promote an older folder copied to the Mac. Keep building and activation as separate operator decisions.

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
- **Migration 207 historical checksum:** the deployment migration tools normalize only the exact known expanded `b160d740...` ledger to canonical `fd7dcd54...`, and only while the exact immutable migration 213 companion is present. Do not edit migration 207 or update the migration ledger manually; any other checksum pair remains a blocking drift error.
- **Failed build:** inspect `windows-build.log` and `windows-build-summary.json` copied to the Mac. A failed job does not install its output.
- **Promotion task missing:** rerun `Initialize-RiversideWindowsBuildWorker.ps1` from elevated Main Hub PowerShell once after installing this phase.
- **Promotion failed:** inspect `promotion-status.json` and the job's `promotion-transcript.txt`; the previous workstation feed remains current.
- **Windows publisher warning:** updater integrity is protected by the Tauri signature, but Windows publisher reputation additionally requires a valid Authenticode certificate configured by thumbprint.
