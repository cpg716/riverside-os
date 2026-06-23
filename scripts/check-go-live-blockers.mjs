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

function exists(file) {
  return fs.existsSync(path.join(root, file));
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
      labelPrint.includes("buildEplDocument") &&
      labelPrint.includes("getInventoryTagPrinterLanguage") &&
      labelPrint.includes("RIVERSIDE_TAG_PRINTER_LANGUAGE") &&
      bridge.includes('RIVERSIDE_TAG_PRINTER_NAME = "Zebra LP 2844"') &&
      bridge.includes('RIVERSIDE_TAG_PRINTER_LANGUAGE: ThermalPrinterLanguage = "epl"'),
    "Tag direct printer path remains locked to the Riverside LP 2844 EPL station",
    labelFile,
    "Riverside production tag printing must target the installed Zebra LP 2844 queue and generate EPL.",
  );
  assert(
    bridge.includes("/api/hardware/print-station") &&
      bridge.includes("printViaMainHubPrintServer") &&
      bridge.includes('if (type === "tag")') &&
      bridge.includes("isLoopbackNetworkTarget(target)") &&
      bridge.includes('if (!isTauri())') &&
      bridge.includes('return printViaMainHubPrintServer(type, asciiToBase64(payload), target, "raw_base64")') &&
      !bridge.includes('if (station === "tag" && isLoopbackNetworkTarget(target)) {\n    return {'),
    "Browser/PWA tag printing uses the Main Hub station print server only with an explicit target",
    bridgeFile,
    "Tags must not use default loopback to silently ask the Main Hub to pick a printer; Tauri dispatches directly to the configured tag target.",
  );
  const serverHardware = read("server/src/api/hardware.rs");
  assert(
    serverHardware.includes('/print-station') &&
      serverHardware.includes("handle_print_station") &&
      serverHardware.includes("resolve_stored_station_target") &&
      serverHardware.includes("print_raw_to_windows_printer") &&
      serverHardware.includes("PrintStation::Tag"),
    "Main Hub hardware API exposes station print dispatch for installed and network printers",
    "server/src/api/hardware.rs",
    "The server must be able to print raw tag payloads to a Windows installed Zebra or a configured network target.",
  );
}

function checkTagDesignerPrintPreviewTruthfulness() {
  const file = "client/src/components/inventory/labelPrint.ts";
  const content = read(file);
  const tagDesignerFile = "client/src/components/settings/TagDesignerPanel.tsx";
  const tagDesigner = read(tagDesignerFile);
  const settingsFile = "client/src/components/settings/PrintersAndScannersPanel.tsx";
  const settings = read(settingsFile);
  assert(
    content.includes("Tag print preview was blocked") &&
      !/return\s+["']blocked["']/.test(content) &&
      !/\|\s*["']blocked["']/.test(content),
    "Tag Designer preview throws instead of reporting success when the preview is blocked",
    file,
    "Blocked tag previews must surface as errors so staff do not see a false print/preview success.",
  );
  assert(
    content.includes("resolveTagPrintTarget") &&
      !content.includes("resolveDesktopTagPrintTarget") &&
      !content.includes("listSystemPrinters") &&
      !content.includes("inferTagPrinterLanguage") &&
      content.includes('autoRoutePrint("tag", payload, language, target)'),
    "Desktop tag print uses the fixed Riverside LP 2844 target",
    file,
    "Default 127.0.0.1 tag configuration must not be used for Riverside production tags.",
  );
  assert(
    content.includes("return RIVERSIDE_TAG_PRINTER_LANGUAGE") &&
      !content.includes("TAG_PRINTER_LANGUAGE_KEY") &&
      !/looksLikeClassic2844|explicitlyZpl|Auto-detect/i.test(content),
    "Tag print language is fixed to Riverside LP 2844 EPL",
    file,
    "Tag payload generation must not depend on generic Zebra language selection or printer-name inference.",
  );
  assert(
    content.includes("Print preview also failed") &&
      content.includes("allowPreviewFallback ?? !isTauri()") &&
      content.includes("autoPrint: true") &&
      content.includes("printExistingWindowAsync(w)") &&
      content.includes("printDialogOpened: options.autoPrint === true") &&
      tagDesigner.includes("allowPreviewFallback: false") &&
      settings.includes("allowPreviewFallback: false"),
    "Tag print fallback reports preview failures and test prints can require real dispatch",
    file,
    "Tag Designer and printer-settings test tags must not fall back to preview; browser/PWA inventory fallback remains explicit and non-successful.",
  );

  assert(
    settings.includes("RIVERSIDE_TAG_PRINTER_NAME") &&
      settings.includes("RIVERSIDE_TAG_PRINTER_LANGUAGE") &&
      !settings.includes('<option value="">Choose language</option>') &&
      !settings.includes("Auto-detect LP/TLP 2844"),
    "Printer settings show the fixed Riverside LP 2844 EPL route",
    settingsFile,
    "Production tag printing must not ask staff to choose unsupported tag printer modes or languages.",
  );
}

function checkRegisterReportPrinterRouting() {
  const file = "client/src/components/pos/zReportPrint.ts";
  const content = read(file);
  const reportPrintFile = "client/src/lib/reportPrint.ts";
  const reportPrint = read(reportPrintFile);
  assert(
    content.includes('import { printReportDocument } from "../../lib/reportPrint"') &&
      content.includes("printReportDocument({") &&
      reportPrint.includes('from "./printerBridge"') &&
      reportPrint.includes("if (isTauri())") &&
      reportPrint.includes("printTextReport(request.text)") &&
      !content.includes("openDesktopTextPreview"),
    "POS register reports use the Reports printer bridge in Tauri desktop",
    file,
    "Register Z-reports and Daily Sales reports must route through the central Reports printer service, not desktop preview files in the Tauri app.",
  );
  assert(
    content.includes("zReportTextLines") &&
      content.includes("dailyReportTextLines") &&
      content.includes("tableReportText"),
    "POS register report helper provides printable text payloads for native Reports printer output",
    file,
    "The Windows Reports printer command prints text files, so each register report path needs a non-empty text payload.",
  );
}

function checkCuratedReportsPrintVisibility() {
  const file = "client/src/components/reports/ReportsWorkspace.tsx";
  const content = read(file);
  assert(
    content.includes("printableDataForReport") &&
      content.includes("handlePrintSelectedReport") &&
      content.includes("disabled={loading || !printableReport || !!loadErr}") &&
      content.includes("report.responseKind === \"register_day_summary\""),
    "Curated Reports expose Print Report for loaded table, summary, and no-row results",
    file,
    "Reports printing must not be hidden just because a report response is summary-shaped or has zero detail rows.",
  );

  const specFile = "client/e2e/reports-mobile-cards.spec.ts";
  const spec = read(specFile);
  assert(
    spec.includes('reports-catalog-card-nys_tax_audit') &&
      spec.includes('name: /^print report$/i'),
    "Curated Reports E2E covers Print Report visibility for non-table report responses",
    specFile,
    "The object-shaped curated report path should keep a visible print option across responsive layouts.",
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

function checkCounterpointBridgeQueryTesterEntityParity() {
  const guiFile = "deployment/counterpoint-bridge-gui/src/App.tsx";
  const bridgeFile = "counterpoint-bridge/index.mjs";
  const gui = read(guiFile);
  const bridge = read(bridgeFile);
  const guiKeys = [
    ...gui.matchAll(/key:\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
  const requiredGuiKeys = [
    "staff",
    "sales_rep_stubs",
    "vendors",
    "customers",
    "store_credit_opening",
    "customer_notes",
    "category_masters",
    "catalog",
    "inventory",
    "vendor_items",
    "gift_cards",
    "tickets",
    "open_docs",
  ];
  const missingGuiKeys = requiredGuiKeys.filter((key) => !guiKeys.includes(key));
  assert(
    missingGuiKeys.length === 0 && gui.includes("value={e.key}"),
    "Counterpoint Bridge GUI query tester posts stable entity keys, not display labels",
    guiFile,
    missingGuiKeys.length > 0
      ? `Missing GUI entity keys: ${missingGuiKeys.join(", ")}`
      : "The query tester dropdown must submit ENTITIES key values.",
  );

  const aliasRequirements = [
    ["staff", "users"],
    ["sales_rep_stubs", "sales_reps"],
    ["vendors", "vendors_filtered"],
    ["store_credit_opening", "store_credit"],
    ["vendor_items", "vend_item"],
  ];
  for (const [guiKey, sqlKey] of aliasRequirements) {
    assert(
      new RegExp(`${guiKey}:\\s*\\[[^\\]]*["']${sqlKey}["']`).test(bridge),
      `Counterpoint query tester maps GUI entity '${guiKey}' to SQL key '${sqlKey}'`,
      bridgeFile,
      "The GUI labels in the Bridge app must resolve to the SQL keys used by the extraction engine.",
    );
  }

  const directSqlKeys = [
    "customers",
    "inventory",
    "catalog",
    "category_masters",
    "customer_notes",
    "gift_cards",
    "tickets",
    "open_docs",
  ];
  const missingSqlKeys = directSqlKeys.filter(
    (key) => !new RegExp(`\\b${key}:\\s*`).test(bridge),
  );
  assert(
    missingSqlKeys.length === 0 &&
      bridge.includes("No SQL mapping is available for query entity") &&
      bridge.includes("Unknown query entity"),
    "Counterpoint query tester distinguishes known-but-unconfigured entities from unknown keys",
    bridgeFile,
    missingSqlKeys.length > 0
      ? `Missing direct SQL keys: ${missingSqlKeys.join(", ")}`
      : "Known GUI entities should not display Unknown query entity just because an optional SQL mapping is empty.",
  );
}

function checkCounterpointSyncStagingVisibility() {
  const panelFile = "client/src/components/settings/CounterpointSyncSettingsPanel.tsx";
  const panel = read(panelFile);
  assert(
    panel.includes("staging_entity_counts?: StagingEntityCountRow[]") &&
      panel.includes("for (const count of status?.staging_entity_counts ?? [])") &&
      panel.includes("rows.set(count.entity") &&
      panel.includes("Queued in ROS support queue") &&
      panel.includes("Applied from ROS support queue") &&
      panel.includes("No live write has happened yet."),
    "Main Hub Counterpoint Sync screen shows queued rows even before live apply",
    panelFile,
    "Bridge-extracted rows must not appear as No Data just because they are still in a support queue.",
  );
  assert(
    panel.includes('data-testid="counterpoint-bridge-connection-status"') &&
      panel.includes("Bridge connection status") &&
      panel.includes("Direct ROS intake") &&
      panel.includes("status?.last_seen_at") &&
      panel.includes("No accepted heartbeat") &&
      panel.includes("Main Hub ROS intake") &&
      panel.includes("ROS staging:"),
    "Main Hub Counterpoint screen shows explicit Bridge connection health",
    panelFile,
    "Operators must be able to distinguish Bridge mode, ROS heartbeat, and ROS staging state for the direct Main Hub ROS intake path.",
  );

  const apiFile = "server/src/api/counterpoint_sync.rs";
  const api = read(apiFile);
  assert(
    api.includes("list_staging_entity_counts") &&
      api.includes('obj.insert("staging_entity_counts".into()') &&
      api.includes("staging_pending_count") &&
      api.includes("staging_applying_count"),
    "Counterpoint Sync status API includes staging counts by entity for the Main Hub UI",
    apiFile,
    "The UI cannot reconcile Bridge rows with staged ROS rows unless the status payload includes entity-level staging counts.",
  );
}

function checkCounterpointImportRunKindSchemaParity() {
  const logicFile = "server/src/logic/counterpoint_sync.rs";
  const migrationFile = "migrations/090_counterpoint_import_run_kind_modes.sql";
  const logic = read(logicFile);
  const migration = read(migrationFile);
  const requiredRunKinds = [
    "preflight",
    "full_import",
    "fix_rerun",
    "incremental_update",
    "go_live",
  ];
  const constraintStart = migration.indexOf("ADD CONSTRAINT counterpoint_import_runs_run_kind_check");
  const activeConstraint = constraintStart >= 0 ? migration.slice(constraintStart) : "";
  const missingLogicRunKinds = requiredRunKinds.filter((kind) => !logic.includes(`"${kind}"`));
  const missingMigrationRunKinds = requiredRunKinds.filter((kind) => !activeConstraint.includes(`'${kind}'`));
  const legacyMigrationRunKinds = ["'rehearsal'", "'full_rehearsal'"].filter((kind) =>
    activeConstraint.includes(kind),
  );
  assert(
    constraintStart >= 0 &&
      missingLogicRunKinds.length === 0 &&
      missingMigrationRunKinds.length === 0 &&
      legacyMigrationRunKinds.length === 0,
    "Counterpoint import run-kind schema matches Bridge/API modes",
    constraintStart < 0 || missingMigrationRunKinds.length > 0 || legacyMigrationRunKinds.length > 0 ? migrationFile : logicFile,
    constraintStart < 0
      ? "Migration is missing the counterpoint_import_runs_run_kind_check constraint replacement."
      : missingMigrationRunKinds.length > 0
      ? `Migration constraint is missing run kind(s): ${missingMigrationRunKinds.join(", ")}`
      : legacyMigrationRunKinds.length > 0
        ? `Migration constraint still allows legacy run kind(s): ${legacyMigrationRunKinds.join(", ")}`
      : missingLogicRunKinds.length > 0
        ? `Server normalization is missing run kind(s): ${missingLogicRunKinds.join(", ")}`
        : "Main Hub must accept every normalized Bridge import mode before landed proof can be written.",
  );
}

function checkCounterpointBridgeGuiUpdateWiring() {
  const updatesFile = "deployment/counterpoint-bridge-gui/src-tauri/src/app_updates.rs";
  const updates = read(updatesFile);
  assert(
    updates.includes("RIVERSIDE_COUNTERSYNC_UPDATER_ENDPOINT") &&
      updates.includes("RIVERSIDE_COUNTERSYNC_UPDATER_PUBLIC_KEY") &&
      updates.includes("version_comparator") &&
      updates.includes("release_build_id") &&
      updates.includes("download_and_install"),
    "Counterpoint Bridge GUI updater uses signed same-version-aware update metadata",
    updatesFile,
    "The Bridge GUI must be updateable independently from the Main Hub app when release assets are rebuilt.",
  );

  const guiFile = "deployment/counterpoint-bridge-gui/src/App.tsx";
  const gui = read(guiFile);
  assert(
    gui.includes('invoke<UpdateCheckResult>("check_app_update")') &&
      gui.includes('invoke<InstallUpdateResult>("install_app_update")') &&
      gui.includes("Bridge GUI Update"),
    "Counterpoint Bridge GUI exposes check/install controls for its signed updater channel",
    guiFile,
    "Main Hub staff need a visible way to update the Bridge GUI without reinstalling by hand.",
  );

  const workflowFile = ".github/workflows/windows-deployment-package.yml";
  const workflow = read(workflowFile);
  assert(
    workflow.includes("RIVERSIDE_COUNTERSYNC_UPDATER_ENDPOINT") &&
      workflow.includes("latest-countersync-bridge-gui.json") &&
      workflow.includes("counterpoint-bridge-gui-updater-build-manifest.json") &&
      workflow.includes("--manifest latest-countersync-bridge-gui.json") &&
      workflow.includes("--build-manifest counterpoint-bridge-gui-updater-build-manifest.json"),
    "Windows deployment workflow publishes and verifies Counterpoint Bridge GUI updater assets",
    workflowFile,
    "The Bridge GUI updater is only useful if the release package publishes and verifies its manifest and build metadata.",
  );
}

function checkCounterpointBridgeDeploymentPackaging() {
  const builderFile = "deployment/windows/build-deployment-package.ps1";
  const builder = read(builderFile);
  assert(
    builder.includes("counterpoint-bridge-gui") &&
      builder.includes("counterpointBridgeGuiPath") &&
      !builder.includes("Copy-CounterpointSyncWorkbench") &&
      !builder.includes("counterpoint-sync-workbench") &&
      !builder.includes("Start-CounterpointSYNCWorkbench.ps1") &&
      !builder.includes("Start-CounterpointSYNCWorkbench.cmd") &&
      !builder.includes("set-counterpoint-bridge-token.ps1") &&
      !builder.includes("Set-CounterpointBridgeToken.cmd") &&
      !builder.includes("counterpoint-sync-bridge"),
    "Windows deployment package includes only the direct ROS Counterpoint Bridge GUI, not obsolete SYNC Workbench payloads",
    builderFile,
    "Go-live Counterpoint import now uses Bridge GUI -> Main Hub ROS. The deployment ZIP must not carry the retired standalone SYNC Workbench or token helper.",
  );

  const obsoletePaths = [
    ".github/workflows/tauri-register-updater-release.yml",
    ".github/workflows/tauri-register-build.yml",
    ".github/workflows/counterpoint-bridge-gui-release.yml",
    "scripts/package-counterpoint-bridge.sh",
    "scripts/smoke-counterpoint-bridge-package.sh",
    "deployment/windows/Start-CounterpointSYNCWorkbench.ps1",
    "deployment/windows/Start-CounterpointSYNCWorkbench.cmd",
    "deployment/windows/set-counterpoint-bridge-token.ps1",
    "deployment/windows/Set-CounterpointBridgeToken.cmd",
    "counterpoint-sync/index.mjs",
    "counterpoint-sync/package.json",
  ];
  const present = obsoletePaths.filter((file) => exists(file));
  assert(
    present.length === 0,
    "Retired standalone SYNC Workbench and duplicate Bridge-only release builders are not present in the source tree",
    builderFile,
    present.length > 0
      ? `Remove obsolete files before release: ${present.join(", ")}`
      : "The go-live package path keeps direct ROS Bridge GUI packaging, canonical Windows updater/deployment assets, and the macOS ROS Dev Center management app.",
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

function checkWindowsInstallerRerunIdempotency() {
  const installerFile = "deployment/windows/install-server.ps1";
  const installer = read(installerFile);
  assert(
    !installer.includes("ON CONFLICT (version)") &&
      installer.includes("SELECT 1 FROM ros_schema_migrations WHERE version = '$migrationVersion'"),
    "Windows installer migration ledger recovery does not require a pre-existing version constraint",
    installerFile,
    "Rerun installs can recover 001_core_identity_staff before 007 adds ros_schema_migrations_pkey.",
  );
  assert(
    !installer.includes("ON CONFLICT (cashier_code)") &&
      installer.includes("SELECT 1 FROM staff WHERE cashier_code = '1234'"),
    "Windows installer bootstrap admin does not require staff cashier uniqueness before constraints migrate",
    installerFile,
    "Rerun installs can recreate Chris G before 007 adds staff_cashier_code_key.",
  );

  const repairFile = "deployment/windows/repair-bootstrap-admin.ps1";
  const repair = read(repairFile);
  assert(
    !repair.includes("ON CONFLICT (cashier_code)") &&
      repair.includes("SELECT 1 FROM staff WHERE cashier_code = '1234'"),
    "Bootstrap admin repair script does not require staff cashier uniqueness before constraints migrate",
    repairFile,
    "The standalone bootstrap repair path must work on partially migrated Main Hub databases.",
  );
}

function checkDeploymentManagerPersistentLogs() {
  const backendFile = "deployment/manager-app/src-tauri/src/lib.rs";
  const backend = read(backendFile);
  assert(
    backend.includes("deployment-manager.log") &&
      backend.includes("append_persistent_log") &&
      backend.includes("emit_deployment_log") &&
      backend.includes("open_deployment_log"),
    "Deployment Manager mirrors execution output to deployment-manager.log",
    backendFile,
    "The package README promises a deployment-manager.log file next to the installer for support.",
  );

  const frontendFile = "deployment/manager-app/src/App.tsx";
  const frontend = read(frontendFile);
  assert(
    frontend.includes("Open Log File") && frontend.includes("open_deployment_log"),
    "Deployment Manager exposes the persistent execution log from the output console",
    frontendFile,
    "Staff must be able to open the saved installer/update log without relying on clipboard copy.",
  );

  const serverManagerFile = "deployment/server-manager-app/src-tauri/src/lib.rs";
  const serverManager = read(serverManagerFile);
  assert(
    serverManager.includes("server-manager.log") &&
      serverManager.includes("append_persistent_log") &&
      serverManager.includes("emit_server_manager_log") &&
      serverManager.includes("Persistent log:"),
    "ROS Server Manager mirrors action output to server-manager.log",
    serverManagerFile,
    "Server recovery actions must leave a saved log under the Main Hub logs directory.",
  );
}

function checkDeploymentManagerActionWiring() {
  const frontendFile = "deployment/manager-app/src/App.tsx";
  const frontend = read(frontendFile);
  assert(
    !frontend.includes("confirm(") &&
      !frontend.includes("setTimeout(") &&
      !frontend.includes("Seed Database") &&
      frontend.includes("requestConfirmation") &&
      frontend.includes("renderExecutionOutput") &&
      frontend.includes("newConfig.register.apiBase = normalizeApiBaseInput(serverIp)") &&
      frontend.includes("remove-standalone-app.ps1") &&
      !frontend.includes("counterpointToken") &&
      !frontend.includes("set-counterpoint-bridge-token.ps1"),
    "Deployment Manager visible actions are wired, confirmable, and use the shared execution console",
    frontendFile,
    "Avoid browser prompts, arbitrary refresh timers, dead seed actions, unwired standalone API config, and obsolete Counterpoint token prompts.",
  );

  const scriptCalls = sortedSet(
    [...frontend.matchAll(/executeScript\('([^']+)'/g)].map((match) => match[1]),
  );
  const missingScripts = scriptCalls.filter(
    (script) => !fs.existsSync(path.join(root, "deployment/windows", script)),
  );
  assert(
    missingScripts.length === 0,
    "Deployment Manager script buttons point to packaged Windows scripts",
    frontendFile,
    missingScripts.length > 0
      ? `Missing scripts: ${missingScripts.join(", ")}`
      : "Every executeScript button should resolve inside deployment/windows.",
  );

  const backendFile = "deployment/manager-app/src-tauri/src/lib.rs";
  const backend = read(backendFile);
  assert(
    backend.includes("format_script_args_for_log") &&
      backend.includes("\"-token\"") &&
      backend.includes("[redacted]"),
    "Deployment Manager masks sensitive script arguments in persistent execution logs",
    backendFile,
    "Counterpoint bridge tokens and future password-like args must not be written to deployment-manager.log.",
  );
}

function checkReleaseWorkflowPreBuildGates() {
  const packageJson = read("package.json");
  assert(
    packageJson.includes('"check:pre-retag"') &&
      packageJson.includes('"release:retag"') &&
      packageJson.includes('"check:financial-invariants"'),
    "Root package exposes pre-retag and guarded retag commands",
    "package.json",
    "Same-version rebuilds must use npm run check:pre-retag and npm run release:retag -- <tag>; financial invariants must remain an explicit root gate.",
  );

  const retagWrapperFile = "scripts/release-retag.mjs";
  const retagWrapper = read(retagWrapperFile);
  assert(
    retagWrapper.includes("git([\"status\", \"--porcelain\"]") &&
      retagWrapper.includes("npm\", [\"run\", \"check:pre-retag\"]") &&
      retagWrapper.includes("gh([") &&
      retagWrapper.includes("--latest"),
    "Guarded retag wrapper refuses dirty releases and runs pre-retag checks",
    retagWrapperFile,
    "Manual same-version retags should be replaced by npm run release:retag -- <tag>.",
  );

  const workflowFiles = [
    ".github/workflows/windows-deployment-package.yml",
  ];
  for (const file of workflowFiles) {
    const content = read(file);
    assert(
      content.includes("npm run check:pre-retag") &&
        content.includes("pre-retag-gate"),
      `Release workflow runs the unified pre-retag gate before expensive build work in ${file}`,
      file,
      "Print, Counterpoint, Help packaging, dirty migration, version, and installer regressions should fail before asset packaging.",
    );
    assert(
      content.includes("package-lock.json") &&
        content.includes("client/package-lock.json"),
      `Release workflow installs pre-retag dependencies before build work in ${file}`,
      file,
      "The unified pre-retag gate needs root and client dependencies before asset packaging begins.",
    );
  }

  const updaterFile = ".github/workflows/windows-deployment-package.yml";
  const updater = read(updaterFile);
  assert(
    updater.includes("require-playwright-green") &&
      /publish-app-updater-only:\s*[\s\S]*?needs:\s*\[[^\]]*require-playwright-green[^\]]*\]/.test(updater) &&
      /assemble-package:\s*[\s\S]*?needs:\s*\[[^\]]*require-playwright-green[^\]]*\]/.test(updater),
    "Windows deployment release waits for same-commit Playwright E2E before publishing updater assets",
    updaterFile,
    "The canonical Windows deployment workflow can build in parallel, but release publishing must remain gated behind same-commit Playwright proof.",
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
      updater.includes("health_ep = contract::HEALTH_ENDPOINT") &&
      updater.includes("select_deployment_asset") &&
      updater.includes("is_main_hub_update_asset") &&
      updater.includes("build_ids_match") &&
      updater.includes("verify_deployment_package_build") &&
      updater.includes("sourceGitSha") &&
      updater.includes("Deployment package build mismatch"),
    "Main Hub in-app updater runs server, bootstrap, local desktop app, transcript, and health-check steps",
    updaterFile,
    "Main Hub updates must cover server/API, migrations, bootstrap admin, local desktop app config, readiness proof, and exact build selection.",
  );

  const updatePanel = "client/src/components/settings/UpdateManagerPanel.tsx";
  const updatePanelContent = read(updatePanel);
  assert(
    updatePanelContent.includes("serverUpdateCheck?.latest_build_sha") &&
      updatePanelContent.includes("Extracting and verifying package build") &&
      updatePanelContent.includes("Update runner launched"),
    "Main Hub update panel passes latest build SHA and labels runner launch accurately",
    updatePanel,
    "Same-version Main Hub rebuilds must install the exact deployment build advertised by update-check.",
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

function checkFinancialInvariantGate() {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-financial-invariants.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) {
    fail(
      "Financial invariant gate failed to start",
      "scripts/check-financial-invariants.mjs",
      result.error.message,
    );
    return;
  }
  assert(
    result.status === 0,
    "Financial invariant gate passes",
    "scripts/check-financial-invariants.mjs",
    result.status === 0
      ? "Financial source, policy, E2E coverage, and production probe invariants passed."
      : `${result.stdout || ""}${result.stderr || ""}`.trim(),
  );
}

function checkStaffCustomerSaveContracts() {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-staff-customer-save-contracts.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) {
    fail(
      "Staff/Customer save-contract gate failed to start",
      "scripts/check-staff-customer-save-contracts.mjs",
      result.error.message,
    );
    return;
  }
  assert(
    result.status === 0,
    "Staff/Customer save-contract gate passes",
    "scripts/check-staff-customer-save-contracts.mjs",
    result.status === 0
      ? "Staff role defaults and Customer profile sparse-save contracts passed."
      : `${result.stdout || ""}${result.stderr || ""}`.trim(),
  );
}

checkCurrentReleaseNotes();
checkTauriOpenerAcl();
checkBrowserPrintHelper();
checkNoLegacyTauriGlobalDetection();
checkNoComponentBrowserPrintBypass();
checkFireAndForgetPrintsAreCaught();
checkDirectPrinterRouting();
checkTagDesignerPrintPreviewTruthfulness();
checkRegisterReportPrinterRouting();
checkCuratedReportsPrintVisibility();
checkPrintRoutingManifest();
checkCounterpointBridgeQueryTesterEntityParity();
checkCounterpointSyncStagingVisibility();
checkCounterpointImportRunKindSchemaParity();
checkCounterpointBridgeGuiUpdateWiring();
checkCounterpointBridgeDeploymentPackaging();
checkCounterpointRateLimitBypass();
checkCounterpointWorkbenchSql();
checkPackagedHelpManuals();
checkGeneratedHelpManualCoverage();
checkWindowsRosieProcessLockGuards();
checkWindowsInstallerRerunIdempotency();
checkDeploymentManagerPersistentLogs();
checkDeploymentManagerActionWiring();
checkReleaseWorkflowPreBuildGates();
checkDesktopAndPwaUpdateWiring();
checkStaffCustomerSaveContracts();
checkFinancialInvariantGate();

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
