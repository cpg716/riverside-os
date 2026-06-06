#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.log(`Usage: node scripts/check-help-impact.mjs [--base <git-ref>] [--help-not-needed]

Checks whether user-facing ROS changes were accompanied by Help/docs/ROSIE updates.

Options:
  --base <git-ref>       Compare committed changes against <git-ref>...HEAD.
                         Uncommitted and untracked files are always included.
  --help-not-needed      Allow impacted changes without Help/docs updates for this run.

Environment:
  HELP_IMPACT_BASE       Same as --base.
  HELP_IMPACT_NOT_NEEDED Set to 1/true to allow impacted changes without Help/docs updates.
`);
}

const args = process.argv.slice(2);
let baseRef = process.env.HELP_IMPACT_BASE?.trim() || "";
let helpNotNeeded =
  /^(1|true|yes)$/i.test(process.env.HELP_IMPACT_NOT_NEEDED ?? "");

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (arg === "--base") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--base requires a git ref");
    }
    baseRef = value;
    index += 1;
    continue;
  }
  if (arg === "--help-not-needed") {
    helpNotNeeded = true;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitLines(args) {
  try {
    return git(args)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function unique(values) {
  return [...new Set(values)].sort();
}

function changedFiles() {
  const files = [];
  if (baseRef) {
    files.push(
      ...gitLines(["diff", "--name-only", "--diff-filter=ACMRTUXB", `${baseRef}...HEAD`]),
    );
  } else {
    files.push(...gitLines(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"]));
  }
  files.push(...gitLines(["diff", "--name-only", "--diff-filter=ACMRTUXB"]));
  files.push(...gitLines(["ls-files", "--others", "--exclude-standard"]));
  return unique(files.map((file) => file.split(path.sep).join("/")));
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) =>
    typeof pattern === "string" ? file === pattern || file.startsWith(pattern) : pattern.test(file),
  );
}

const impactPatterns = [
  "client/src/App.tsx",
  "client/src/components/",
  "client/src/context/",
  "client/src/lib/",
  "client/src-tauri/src/",
  "server/src/api/",
  "server/src/auth/",
  "server/src/logic/",
  "server/src/middleware/",
  "server/src/models/",
  "server/src/services/",
];

const helpPatterns = [
  /^client\/src\/assets\/docs\/.*-manual\.md$/,
  "client/src/assets/docs/help-quality-report.generated.json",
  "client/src/assets/images/help/",
  "client/src/lib/help/help-manifest.generated.ts",
  "client/UI_WORKSPACE_INVENTORY.md",
  "client/scripts/capture-help-screenshots.mjs",
  "client/scripts/generate-help-manifest.mjs",
  "client/scripts/help-screenshot-specs.mjs",
  "server/src/logic/help_corpus_manuals.generated.rs",
  "AGENTS.md",
  "CHANGELOG.md",
  "DEVELOPER.md",
  "README.md",
  "UI_STANDARDS.md",
  /^docs\/.*\.md$/,
  "docs/MANUAL_CREATION.md",
  "docs/ROS_AI_HELP_CORPUS.md",
  "docs/AI_CONTEXT_FOR_ASSISTANTS.md",
  "docs/PLAN_LOCAL_LLM_HELP.md",
  /^docs\/ROSIE.*\.md$/,
  /^docs\/staff\//,
];

const impactExclusions = [
  "client/src/lib/help/help-manifest.generated.ts",
  "server/src/logic/help_corpus_manuals.generated.rs",
  /^client\/src\/assets\/docs\//,
  /^client\/src\/assets\/images\/help\//,
  /^client\/scripts\/(?:capture-help-screenshots|generate-help-manifest|help-screenshot-specs)\.mjs$/,
];

function isImpactFile(file) {
  return matchesAny(file, impactPatterns) && !matchesAny(file, impactExclusions);
}

function areaFor(file) {
  if (file.startsWith("client/src/components/")) return file.split("/").slice(3, 5).join("/");
  if (file.startsWith("client/src/lib/")) return file.split("/").slice(3, 5).join("/");
  if (file.startsWith("server/src/api/")) return `api/${path.basename(file, path.extname(file))}`;
  if (file.startsWith("server/src/logic/")) return `logic/${path.basename(file, path.extname(file))}`;
  if (file.startsWith("server/src/services/")) return `services/${path.basename(file, path.extname(file))}`;
  return file.split("/").slice(0, 3).join("/");
}

function manualSuggestions(impactFiles) {
  const docsDir = path.join(process.cwd(), "client", "src", "assets", "docs");
  if (!fs.existsSync(docsDir)) return [];
  const manuals = fs
    .readdirSync(docsDir)
    .filter((file) => file.endsWith("-manual.md"))
    .map((file) => file.replace(/-manual\.md$/, ""));
  const tokens = new Set();
  for (const file of impactFiles) {
    for (const part of file
      .replace(/\.[^.]+$/, "")
      .split(/[\/_-]/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 4)) {
      tokens.add(part);
    }
  }
  return manuals
    .filter((manual) => [...tokens].some((token) => manual.includes(token)))
    .slice(0, 12);
}

const files = changedFiles();
const impactFiles = files.filter(isImpactFile);
const helpFiles = files.filter((file) => matchesAny(file, helpPatterns));

if (impactFiles.length === 0) {
  console.log("Help impact check: no user-facing ROS changes detected.");
  process.exit(0);
}

if (helpFiles.length > 0) {
  console.log(
    `Help impact check: ${impactFiles.length} impacted file(s), ${helpFiles.length} Help/docs/ROSIE update file(s) detected.`,
  );
  process.exit(0);
}

if (helpNotNeeded) {
  console.log(
    `Help impact check: ${impactFiles.length} impacted file(s), bypassed by explicit help-not-needed override.`,
  );
  process.exit(0);
}

const areas = unique(impactFiles.map(areaFor)).slice(0, 12);
const suggestions = manualSuggestions(impactFiles);

console.error("Help impact check failed: user-facing ROS changes need Help/docs/ROSIE review.");
console.error("");
console.error("Impacted areas:");
for (const area of areas) console.error(`- ${area}`);
if (suggestions.length > 0) {
  console.error("");
  console.error("Likely manuals to review:");
  for (const manual of suggestions) console.error(`- client/src/assets/docs/${manual}-manual.md`);
}
console.error("");
console.error("Fix by updating relevant markdown docs, Help manuals/screenshots/generated Help artifacts, or rerun with:");
console.error("- HELP_IMPACT_NOT_NEEDED=1 npm run check:help-impact");
console.error("- npm run check:help-impact -- --help-not-needed");
process.exit(1);
