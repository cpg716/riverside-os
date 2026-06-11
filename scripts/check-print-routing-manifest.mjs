#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const manifestFile = "docs/print-routing-manifest.json";
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestFile), "utf8"));

const failures = [];
const trackedCallees = [
  {
    name: "openPrintableHtml",
    pattern: /\bopenPrintableHtml\s*\(/g,
  },
  {
    name: "openDesktopTextPreview",
    pattern: /\bopenDesktopTextPreview\s*\(/g,
  },
  {
    name: "printTextReport",
    pattern: /\bprintTextReport\s*\(/g,
  },
  {
    name: "printReportDocument",
    pattern: /\bprintReportDocument\s*\(/g,
  },
  {
    name: "printPlainTextReport",
    pattern: /\bprintPlainTextReport\s*\(/g,
  },
  {
    name: "openInventoryTagsWindow",
    pattern: /\bopenInventoryTagsWindow\s*\(/g,
  },
  {
    name: "openInventoryTagsPreviewWindow",
    pattern: /\bopenInventoryTagsPreviewWindow\s*\(/g,
  },
  {
    name: "printRawEscPosBase64",
    pattern: /\bprintRawEscPosBase64\s*\(/g,
  },
  {
    name: "printReceiptBase64",
    pattern: /\bprintReceiptBase64\s*\(/g,
  },
  {
    name: "printReceiptPayload",
    pattern: /\bprintReceiptPayload\s*\(/g,
  },
  {
    name: "printReceiptText",
    pattern: /\bprintReceiptText\s*\(/g,
  },
  {
    name: "autoRoutePrint",
    pattern: /\bautoRoutePrint\s*\(/g,
  },
  {
    name: "writeAndPrintHtmlFrame",
    pattern: /\bwriteAndPrintHtmlFrame\s*\(/g,
  },
  {
    name: "printExistingWindow",
    pattern: /\bprintExistingWindow\s*\(/g,
  },
  {
    name: "window.open",
    pattern: /\bwindow\s*\.\s*open\s*\(/g,
  },
  {
    name: "window.print",
    pattern: /\bwindow\s*\.\s*print\s*\(/g,
  },
  {
    name: "targetWindow.print",
    pattern: /\btargetWindow\s*\.\s*print\s*\(/g,
  },
];

const previewCallees = new Set([
  "openPrintableHtml",
  "openDesktopTextPreview",
  "openInventoryTagsPreviewWindow",
  "window.open",
]);

const directPrinterCallees = new Map([
  ["receipt", new Set(["printRawEscPosBase64", "printReceiptBase64", "printReceiptPayload", "printReceiptText"])],
  ["cash-drawer", new Set(["printRawEscPosBase64", "printReceiptBase64"])],
  ["report", new Set(["printTextReport", "printReportDocument", "printPlainTextReport"])],
  ["tag", new Set(["openInventoryTagsWindow", "autoRoutePrint"])],
]);

function rel(file) {
  return file.split(path.sep).join("/");
}

function walk(dir, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(rel(path.relative(root, full)), out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(rel(path.relative(root, full)));
    }
  }
  return out;
}

function lineBounds(content, index) {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const endIndex = content.indexOf("\n", index);
  const end = endIndex === -1 ? content.length : endIndex;
  return [start, end];
}

function lineNumber(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDeclarationLine(line, callee) {
  if (callee.includes(".")) return false;
  return new RegExp(`\\bfunction\\s+${escapeRegExp(callee)}\\s*\\(`).test(line);
}

function scanPrintRoutes() {
  const ignoredHelpers = new Set(manifest.ignoredHelpers ?? []);
  const discovered = new Map();
  for (const file of walk("client/src")) {
    if (ignoredHelpers.has(file)) continue;
    const content = fs.readFileSync(path.join(root, file), "utf8");
    for (const callee of trackedCallees) {
      callee.pattern.lastIndex = 0;
      let match;
      while ((match = callee.pattern.exec(content)) !== null) {
        const [start, end] = lineBounds(content, match.index);
        const line = content.slice(start, end);
        if (isDeclarationLine(line, callee.name)) continue;

        const key = `${file}::${callee.name}`;
        const entry = discovered.get(key) ?? {
          file,
          callee: callee.name,
          occurrences: 0,
          lines: [],
        };
        entry.occurrences += 1;
        entry.lines.push(lineNumber(content, match.index));
        discovered.set(key, entry);
      }
    }
  }
  return discovered;
}

function fail(message, detail) {
  failures.push({ message, detail });
}

function validateManifestRoute(route, index) {
  const prefix = `${manifestFile} routes[${index}]`;
  for (const field of ["id", "file", "callee", "occurrences", "kind", "route"]) {
    if (!route[field]) fail(`${prefix} is missing ${field}`, JSON.stringify(route));
  }
  if (!Number.isInteger(route.occurrences) || route.occurrences < 1) {
    fail(`${prefix} has invalid occurrences`, `${route.id}: ${route.occurrences}`);
  }
  if (route.callee === "window.print" || route.callee === "targetWindow.print") {
    fail(`${prefix} classifies a direct browser print call`, `${route.id}: use a shared print helper instead.`);
  }
  if (route.callee === "writeAndPrintHtmlFrame" || route.callee === "printExistingWindow") {
    fail(`${prefix} classifies a legacy browser print helper`, `${route.id}: use openPrintableHtml or a direct bridge route.`);
  }
  if (route.route === "direct") {
    const allowed = directPrinterCallees.get(route.printer);
    if (!allowed) {
      fail(`${prefix} direct route has no recognized printer`, `${route.id}: printer=${route.printer ?? ""}`);
    } else if (!allowed.has(route.callee)) {
      fail(
        `${prefix} direct ${route.printer} route uses the wrong bridge`,
        `${route.id}: ${route.callee} is not one of ${[...allowed].join(", ")}`,
      );
    }
    if (!route.proof) fail(`${prefix} direct route is missing proof`, route.id);
  } else if (route.route === "preview") {
    if (!previewCallees.has(route.callee)) {
      fail(
        `${prefix} preview route uses a non-preview bridge`,
        `${route.id}: ${route.callee} is not one of ${[...previewCallees].join(", ")}`,
      );
    }
    if (!route.previewReason) fail(`${prefix} preview route is missing previewReason`, route.id);
  } else {
    fail(`${prefix} has unknown route type`, `${route.id}: ${route.route}`);
  }
}

function expectedRoutesByKey() {
  const expected = new Map();
  const ids = new Set();
  for (const [index, route] of (manifest.routes ?? []).entries()) {
    validateManifestRoute(route, index);
    if (ids.has(route.id)) fail("Duplicate print route id", route.id);
    ids.add(route.id);

    const key = `${route.file}::${route.callee}`;
    const entry = expected.get(key) ?? {
      file: route.file,
      callee: route.callee,
      occurrences: 0,
      ids: [],
    };
    entry.occurrences += route.occurrences;
    entry.ids.push(route.id);
    expected.set(key, entry);
  }
  return expected;
}

const discovered = scanPrintRoutes();
const expected = expectedRoutesByKey();

for (const [key, actual] of discovered.entries()) {
  const route = expected.get(key);
  if (!route) {
    fail(
      "Unclassified print route discovered",
      `${actual.file}:${actual.lines.join(",")} calls ${actual.callee}; add it to ${manifestFile} with direct/preview routing proof.`,
    );
    continue;
  }
  if (actual.occurrences !== route.occurrences) {
    fail(
      "Print route occurrence count changed",
      `${actual.file} ${actual.callee}: manifest=${route.occurrences}, source=${actual.occurrences}, lines=${actual.lines.join(",")}, ids=${route.ids.join(",")}`,
    );
  }
}

for (const [key, route] of expected.entries()) {
  if (!discovered.has(key)) {
    fail(
      "Manifest print route no longer exists in source",
      `${route.file} ${route.callee}: ids=${route.ids.join(",")}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Print routing manifest check failed.");
  console.error("");
  for (const failure of failures) {
    console.error(`- ${failure.message}`);
    if (failure.detail) console.error(`  detail: ${failure.detail}`);
  }
  process.exit(1);
}

console.log(
  `Print routing manifest check passed (${manifest.routes.length} classified routes, ${discovered.size} source call groups).`,
);
