#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const passes = [];

function rel(file) {
  return file.split(path.sep).join("/");
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
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
    labelPrint.includes('autoRoutePrint("tag"') && labelPrint.includes("buildZplDocument"),
    "Tag direct printer path remains wired to the tag station",
    labelFile,
    "Inventory tag printing must keep routing ZPL through ros.hardware.printer.tag.*.",
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

checkTauriOpenerAcl();
checkBrowserPrintHelper();
checkNoComponentBrowserPrintBypass();
checkFireAndForgetPrintsAreCaught();
checkDirectPrinterRouting();
checkCounterpointRateLimitBypass();
checkCounterpointWorkbenchSql();
checkPackagedHelpManuals();

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
