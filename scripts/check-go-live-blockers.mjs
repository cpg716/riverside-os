#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const failures = [];
const passes = [];

function rel(file) {
  return file.split(path.sep).join("/");
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

function lineOf(content, needle) {
  const index =
    typeof needle === "string" ? content.indexOf(needle) : content.search(needle);
  if (index < 0) return 1;
  return content.slice(0, index).split(/\r?\n/).length;
}

function pass(message) {
  passes.push(message);
}

function fail(message, file, detail) {
  failures.push({ message, file, detail });
}

function assert(condition, message, file, detail) {
  if (condition) {
    pass(message);
  } else {
    fail(message, file, detail);
  }
}

function walk(dir, extensions, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      walk(rel(path.relative(root, full)), extensions, out);
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push(rel(path.relative(root, full)));
    }
  }
  return out;
}

function sortedSet(values) {
  return [...new Set(values)].sort();
}

function checkCurrentReleaseNotes() {
  const version = readJson("package.json").version;
  const file = `docs/releases/v${version}-release-notes.md`;
  const exists = fs.existsSync(path.join(root, file));
  assert(
    exists,
    "Release notes exist for the current package version",
    file,
    "Same-version rebuilds use docs/releases/<tag>-release-notes.md as the canonical GitHub Release body.",
  );
  if (!exists) return;

  const content = read(file);
  assert(
    content.includes(`v${version}`) && content.trim().length > 200,
    "Current release notes mention the current version and are not empty",
    file,
    "Release notes must be current before retagging or publishing same-version assets.",
  );
}

function checkTauriOpenerAcl() {
  const file = "client/src-tauri/capabilities/default.json";
  const json = JSON.parse(read(file));
  const permissions = Array.isArray(json.permissions) ? json.permissions : [];
  const stringPermissions = permissions.filter((permission) => typeof permission === "string");
  assert(
    stringPermissions.includes("opener:allow-open-path"),
    "Tauri desktop preview can call opener.open_path",
    file,
    "Missing opener:allow-open-path; Tag Designer and Help print previews can fail with an ACL error.",
  );
}

function checkBrowserPrintHelper() {
  const file = "client/src/lib/browserPrint.ts";
  const content = read(file);
  assert(
    content.includes("if (isTauri())") && content.includes("openDesktopTextPreview"),
    "HTML print helper routes Tauri desktop previews through the desktop file bridge",
    file,
    "Desktop HTML print/preview must not depend on hidden iframe or browser print windows.",
  );
  assert(
    !/return\s+["']blocked["']/.test(content) && !/\|\s*["']blocked["']/.test(content),
    "HTML print helper throws on blocked browser previews instead of reporting success",
    file,
    "Returning blocked can let callers show success after a popup-blocked print preview.",
  );
  assert(
    /export function writeAndPrintHtmlFrame[\s\S]*?if \(isTauri\(\)\)[\s\S]*?openDesktopTextPreview/.test(
      content,
    ),
    "Legacy frame print helper is guarded for Tauri desktop",
    file,
    "writeAndPrintHtmlFrame must use desktop preview inside Tauri instead of window.print().",
  );
}

function checkNoLegacyTauriGlobalDetection() {
  const files = walk("client/src", [".ts", ".tsx", ".js", ".jsx"]);
  let found = false;
  for (const file of files) {
    const content = read(file);
    const pattern = /__TAURI__/;
    if (pattern.test(content)) {
      found = true;
      fail(
        "Client code uses stale window.__TAURI__ desktop detection",
        `${file}:${lineOf(content, pattern)}`,
        "Use @tauri-apps/api/core isTauri() so desktop print/preview paths do not silently fall back to browser windows.",
      );
    }
  }
  if (!found) pass("Client desktop detection uses isTauri() instead of window.__TAURI__");
}

function checkNoComponentBrowserPrintBypass() {
  const files = walk("client/src/components", [".ts", ".tsx", ".js", ".jsx"]);
  const forbidden = [
    { pattern: /\bwindow\.print\s*\(/, label: "window.print()" },
    { pattern: /\btargetWindow\.print\s*\(/, label: "targetWindow.print()" },
    { pattern: /\bprintExistingWindow\s*\(/, label: "printExistingWindow()" },
    { pattern: /\bwriteAndPrintHtmlFrame\s*\(/, label: "writeAndPrintHtmlFrame()" },
  ];

  let found = false;
  for (const file of files) {
    const content = read(file);
    for (const { pattern, label } of forbidden) {
      if (pattern.test(content)) {
        found = true;
        fail(
          `Component bypasses shared desktop-safe print helper with ${label}`,
          `${file}:${lineOf(content, pattern)}`,
          "Use openPrintableHtml, printTextReport, or the hardware printer bridge instead.",
        );
      }
    }
  }
  if (!found) pass("No component directly bypasses shared print routing");
}

function checkFireAndForgetPrintsAreCaught() {
  const files = walk("client/src", [".ts", ".tsx", ".js", ".jsx"]).filter(
    (file) => file !== "client/src/lib/browserPrint.ts",
  );
  let found = false;
  for (const file of files) {
    const content = read(file);
    let index = content.indexOf("void openPrintableHtml");
    while (index >= 0) {
      const window = content.slice(index, index + 20_000);
      if (!window.includes(".catch(")) {
        found = true;
        fail(
          "Fire-and-forget print preview has no visible failure handler",
          `${file}:${lineOf(content, "void openPrintableHtml")}`,
          "Add .catch(...) with a toast/status message so print failures do not look successful.",
        );
      }
      index = content.indexOf("void openPrintableHtml", index + 1);
    }
  }
  if (!found) pass("Fire-and-forget HTML print previews surface failures");
}

function checkDirectPrinterRouting() {
  const bridgeFile = "client/src/lib/printerBridge.ts";
  const bridge = read(bridgeFile);
  assert(
    bridge.includes('resolvePrinterTarget("report")') &&
      bridge.includes("print_text_to_system_printer") &&
      bridge.includes('target.mode !== "system"'),
    "Reports direct printer path remains wired to the Tauri system-printer command",
    bridgeFile,
    "printTextReport must target ros.hardware.printer.report.* and invoke print_text_to_system_printer.",
  );
  assert(
    bridge.includes('resolvePrinterTarget("receipt")') &&
      bridge.includes("print_escpos_binary_b64") &&
      bridge.includes("print_raw_to_system_printer_b64"),
    "Receipt direct printer path remains wired to receipt station settings",
    bridgeFile,
    "Receipt printing must keep using ros.hardware.printer.receipt.* through the hardware bridge.",
  );

  const labelFile = "client/src/components/inventory/labelPrint.ts";
  const labelPrint = read(labelFile);
  assert(
    labelPrint.includes('autoRoutePrint("tag"') &&
      labelPrint.includes("buildZplDocument") &&
      labelPrint.includes("buildEplDocument") &&
      labelPrint.includes("getInventoryTagPrinterLanguage") &&
      labelPrint.includes("TAG_PRINTER_LANGUAGE_KEY"),
    "Tag direct printer path remains wired to the tag station with EPL/ZPL language selection",
    labelFile,
    "Inventory tag printing must keep routing through ros.hardware.printer.tag.* and support classic LP/TLP 2844 EPL as well as ZPL.",
  );
}

function checkPrintRoutingManifest() {
  const result = spawnSync(process.execPath, ["scripts/check-print-routing-manifest.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert(
    result.status === 0,
    "Print routing manifest classifies every app print route and bridge choice",
    "docs/print-routing-manifest.json",
    (result.stderr || result.stdout).trim() ||
      "Run npm run check:print-routing for route-level print proof.",
  );
}

function checkCounterpointRateLimitBypass() {
  const file = "server/src/middleware/rate_limit.rs";
  const content = read(file);
  const bypassIndex = content.indexOf("if is_authenticated_counterpoint_bridge_request(&request)");
  const limitIndex = content.indexOf("state.check_ip_limit");
  assert(
    bypassIndex >= 0 && limitIndex >= 0 && bypassIndex < limitIndex,
    "Counterpoint bridge tokened requests bypass the generic IP rate limiter before 429 can fire",
    file,
    "The bypass must run before state.check_ip_limit so high-volume inventory ingest is not cut off.",
  );
  assert(
    content.includes("/api/sync/counterpoint") &&
      content.includes("x-ros-sync-token") &&
      content.includes("AUTHORIZATION") &&
      content.includes("X-RateLimit-Bypass"),
    "Counterpoint rate-limit bypass is scoped to authenticated bridge traffic",
    file,
    "The bypass must be limited to /api/sync/counterpoint and token-bearing requests.",
  );
}

function checkCounterpointWorkbenchSql() {
  const file = "server/src/logic/counterpoint_workbench.rs";
  const content = read(file);
  assert(
    !/GROUP BY b\.source_file_name\s+ORDER BY b\.imported_at DESC/.test(content),
    "Counterpoint workbench data-source health query does not order grouped rows by raw imported_at",
    file,
    "PostgreSQL rejects ORDER BY b.imported_at when grouped only by source_file_name.",
  );
  assert(
    (content.match(/ORDER BY MAX\(b\.imported_at\) DESC/g) ?? []).length >= 2,
    "Counterpoint workbench uses aggregate imported_at ordering for grouped health summaries",
    file,
    "Expected both Lightspeed and Counterpoint CSV health queries to order by MAX(b.imported_at).",
  );
}

function checkPackagedHelpManuals() {
  const generatedFile = "server/src/logic/help_corpus_manuals.generated.rs";
  const generated = read(generatedFile);
  const includeCount = (generated.match(/include_str!\(/g) ?? []).length;
  assert(
    generated.includes("HELP_MANUAL_BUNDLED_MARKDOWN") &&
      generated.includes("help_manual_bundled_markdown") &&
      includeCount >= 10,
    "Server binary embeds Help manual markdown for packaged Windows installs",
    generatedFile,
    "Packaged server must not depend on a dev repo client/src/assets/docs folder.",
  );

  for (const file of [
    "server/src/logic/help_manual_policy.rs",
    "server/src/logic/help_corpus.rs",
  ]) {
    const content = read(file);
    const embeddedIndex = content.indexOf("help_manual_bundled_markdown(rel_path)");
    const fsIndex = content.indexOf("std::fs::read_to_string");
    assert(
      embeddedIndex >= 0 && fsIndex >= 0 && embeddedIndex < fsIndex,
      `Help manual loader checks embedded markdown before filesystem fallback in ${file}`,
      file,
      "Packaged Windows help endpoints should not fail before trying embedded manuals.",
    );
  }
}

function checkGeneratedHelpManualCoverage() {
  const docsDir = "client/src/assets/docs";
  const manualFiles = sortedSet(
    fs
      .readdirSync(path.join(root, docsDir))
      .filter((file) => file.endsWith("-manual.md")),
  );
  const manifestFile = "client/src/lib/help/help-manifest.generated.ts";
  const serverGeneratedFile = "server/src/logic/help_corpus_manuals.generated.rs";
  const manifest = read(manifestFile);
  const serverGenerated = read(serverGeneratedFile);

  const manifestFiles = sortedSet(
    [...manifest.matchAll(/\.\.\/\.\.\/assets\/docs\/([^"]+-manual\.md)\?raw/g)].map(
      (match) => match[1],
    ),
  );
  const serverFiles = sortedSet(
    [...serverGenerated.matchAll(/"client\/src\/assets\/docs\/([^"]+-manual\.md)"/g)].map(
      (match) => match[1],
    ),
  );

  const missingManifest = manualFiles.filter((file) => !manifestFiles.includes(file));
  const staleManifest = manifestFiles.filter((file) => !manualFiles.includes(file));
  const missingServer = manualFiles.filter((file) => !serverFiles.includes(file));
  const staleServer = serverFiles.filter((file) => !manualFiles.includes(file));

  assert(
    missingManifest.length === 0 && staleManifest.length === 0,
    "Client Help manifest covers every committed Help manual without stale manual imports",
    manifestFile,
    [
      missingManifest.length > 0 ? `missing: ${missingManifest.join(", ")}` : "",
      staleManifest.length > 0 ? `stale: ${staleManifest.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ") || "Regenerate Help with npm run generate:help.",
  );
  assert(
    missingServer.length === 0 && staleServer.length === 0,
    "Server embedded Help corpus covers every committed Help manual without stale bundle entries",
    serverGeneratedFile,
    [
      missingServer.length > 0 ? `missing: ${missingServer.join(", ")}` : "",
      staleServer.length > 0 ? `stale: ${staleServer.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ") || "Regenerate Help with npm run generate:help.",
  );
}

function checkWindowsRosieProcessLockGuards() {
  for (const file of [
    "deployment/windows/Install-RosieAiStack.ps1",
    "deployment/windows/install-server.ps1",
  ]) {
    const content = read(file);
    assert(
      content.includes("Stop-ScheduledTask") &&
        content.includes("Riverside OS LLM Host") &&
        content.includes("llama-server") &&
        content.includes("sherpa-onnx-offline") &&
        content.includes("sherpa-onnx-offline-tts") &&
        content.includes("sherpa-onnx") &&
        /Stop-Process[\s\S]*?-Force/.test(content),
      `Windows ROSIE installer path stops running LLM/speech processes before overwriting binaries in ${file}`,
      file,
      "Windows installer rebuilds can fail on locked llama/sherpa DLLs if these process-lock guards are removed.",
    );
  }
}

function checkReleaseWorkflowPreBuildGates() {
  const workflowFiles = [
    ".github/workflows/windows-deployment-package.yml",
    ".github/workflows/tauri-register-updater-release.yml",
    ".github/workflows/macos-ros-dev-center-release.yml",
  ];
  for (const file of workflowFiles) {
    const content = read(file);
    assert(
      content.includes("scripts/check-go-live-blockers.mjs"),
      `Release workflow runs go-live blocker gates before expensive build work in ${file}`,
      file,
      "Print, Counterpoint, Help packaging, and installer-lock regressions should fail before asset packaging.",
    );
    assert(
      content.includes("scripts/check-version-parity.mjs"),
      `Release workflow runs version parity before build work in ${file}`,
      file,
      "Version drift in companion apps or package-lock files can publish stale assets.",
    );
  }

  const updaterFile = ".github/workflows/tauri-register-updater-release.yml";
  const updater = read(updaterFile);
  assert(
    updater.includes("require-playwright-green") &&
      /build-updater:\s*[\s\S]*?needs:\s*require-playwright-green/.test(updater),
    "Windows updater release waits for same-commit Playwright E2E before building assets",
    updaterFile,
    "The updater release must use the same Playwright gate as the deployment package and macOS release.",
  );
}

function checkDesktopAndPwaUpdateWiring() {
  const updaterFile = "client/src-tauri/src/server_updater.rs";
  const updater = read(updaterFile);
  assert(
    updater.includes("./install-server.ps1 -ConfigPath") &&
      updater.includes("./repair-bootstrap-admin.ps1 -ConfigPath") &&
      updater.includes("./install-register.ps1 -ConfigPath") &&
      updater.includes("-StationMode mainhub") &&
      updater.includes("Start-Transcript") &&
      updater.includes("health_ep = contract::HEALTH_ENDPOINT"),
    "Main Hub in-app updater runs server, bootstrap, local desktop app, transcript, and health-check steps",
    updaterFile,
    "Main Hub updates must cover server/API, migrations, bootstrap admin, local desktop app config, and readiness proof.",
  );

  const registerInstaller = "deployment/windows/install-register.ps1";
  const installer = read(registerInstaller);
  assert(
    installer.includes("[switch]$Launch") &&
      installer.includes("if ($Launch -and -not $NoLaunch)") &&
      !installer.includes("if (-not $NoLaunch)"),
    "Register/Main Hub/Back Office installer does not auto-launch unless explicitly requested",
    registerInstaller,
    "Update workflows should finish cleanly and let the operator relaunch intentionally.",
  );

  const appUpdates = "client/src-tauri/src/app_updates.rs";
  const appUpdateContent = read(appUpdates);
  assert(
    appUpdateContent.includes("tauri_plugin_updater") &&
      appUpdateContent.includes("version_comparator") &&
      appUpdateContent.includes("release_build_id") &&
      appUpdateContent.includes("download_and_install"),
    "Desktop app updater handles signed updates and same-version build changes",
    appUpdates,
    "Back Office and Register #1 rely on signed Tauri updater assets and build metadata comparisons.",
  );

  const pwaPrompt = "client/src/components/layout/PwaUpdatePrompt.tsx";
  const pwaPromptContent = read(pwaPrompt);
  assert(
    pwaPromptContent.includes('useRegisterSW()') &&
      pwaPromptContent.includes("needRefresh") &&
      pwaPromptContent.includes("updateServiceWorker(true)") &&
      pwaPromptContent.includes("if (isTauri()) return <DesktopPwaCacheCleanup />"),
    "PWA update prompt is registered for browser/PWA and disabled/cleaned up in Tauri",
    pwaPrompt,
    "Browser/iPad updates should use the service worker prompt; desktop apps should not keep PWA caches.",
  );

  const viteConfig = "client/vite.config.ts";
  const vite = read(viteConfig);
  assert(
    vite.includes("VitePWA({") &&
      vite.includes('registerType: "prompt"') &&
      vite.includes('navigateFallback: "/index.html"') &&
      vite.includes("cleanupOutdatedCaches: true"),
    "PWA build produces a prompt-driven service worker with cleanup and SPA fallback",
    viteConfig,
    "The iPad/browser app must keep service-worker update checks and stale-cache cleanup enabled.",
  );

  const launcher = "server/src/launcher.rs";
  const launcherContent = read(launcher);
  assert(
    launcherContent.includes("apply_static_cache_control") &&
      launcherContent.includes("static_cache_control_for_path") &&
      launcherContent.includes("no-cache, no-store, must-revalidate") &&
      launcherContent.includes("public, max-age=31536000, immutable") &&
      launcherContent.includes('lower == "/sw.js"') &&
      launcherContent.includes('lower == "/manifest.json"') &&
      launcherContent.includes('lower.ends_with("/index.html")') &&
      launcherContent.includes("!last_segment.contains('.')") &&
      launcherContent.includes(".fallback_service(serve_dir)") &&
      launcherContent.includes(".layer(middleware::from_fn(apply_static_cache_control))"),
    "Server applies update-safe cache headers for PWA shell and immutable hashed assets",
    launcher,
    "PWA updates need fresh index/service-worker/manifest files while hashed assets can be cached long-term.",
  );
}

checkCurrentReleaseNotes();
checkTauriOpenerAcl();
checkBrowserPrintHelper();
checkNoLegacyTauriGlobalDetection();
checkNoComponentBrowserPrintBypass();
checkFireAndForgetPrintsAreCaught();
checkDirectPrinterRouting();
checkPrintRoutingManifest();
checkCounterpointRateLimitBypass();
checkCounterpointWorkbenchSql();
checkPackagedHelpManuals();
checkGeneratedHelpManualCoverage();
checkWindowsRosieProcessLockGuards();
checkReleaseWorkflowPreBuildGates();
checkDesktopAndPwaUpdateWiring();

if (failures.length > 0) {
  console.error("Go-live blocker check failed.");
  console.error("");
  for (const failure of failures) {
    console.error(`- ${failure.message}`);
    if (failure.file) console.error(`  file: ${failure.file}`);
    if (failure.detail) console.error(`  detail: ${failure.detail}`);
  }
  process.exit(1);
}

console.log(`Go-live blocker check passed (${passes.length} gates).`);
for (const message of passes) {
  console.log(`- ${message}`);
}
