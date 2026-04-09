#!/usr/bin/env node
/**
 * Discovers in-app Help manuals from `client/src/assets/docs/*-manual.md` (optional YAML front matter).
 * Generates:
 *   - client/src/lib/help/help-manifest.generated.ts
 *   - server/src/logic/help_corpus_manuals.generated.rs
 *
 * Usage (from repo root or client/):
 *   node client/scripts/generate-help-manifest.mjs
 *   node client/scripts/generate-help-manifest.mjs --scaffold <id> --title "Title" [--markdown path]
 *   node client/scripts/generate-help-manifest.mjs --scaffold-components [--dry-run] [--include-shadcn]
 *   node client/scripts/generate-help-manifest.mjs --rescan-components [--dry-run] [--include-shadcn]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot() {
  let dir = path.resolve(__dirname, "..");
  for (let i = 0; i < 10; i += 1) {
    const docs = path.join(dir, "client", "src", "assets", "docs");
    if (fs.existsSync(docs) && fs.statSync(docs).isDirectory()) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find repo root (expected client/src/assets/docs). Run from repo or client/.",
  );
}

const REPO_ROOT = findRepoRoot();
const COMPONENTS_DIR = path.join(REPO_ROOT, "client", "src", "components");
const DOCS_DIR = path.join(REPO_ROOT, "client", "src", "assets", "docs");
const CLIENT_LIB_HELP = path.join(REPO_ROOT, "client", "src", "lib", "help");
const OUT_TS = path.join(CLIENT_LIB_HELP, "help-manifest.generated.ts");
const OUT_RS = path.join(REPO_ROOT, "server", "src", "logic", "help_corpus_manuals.generated.rs");

function posix(p) {
  return p.split(path.sep).join("/");
}

function importPathFromLibHelpToMarkdown(repoMarkdownPath) {
  const absMd = path.join(REPO_ROOT, repoMarkdownPath);
  const rel = path.relative(CLIENT_LIB_HELP, absMd);
  if (rel.startsWith("..")) return `${posix(rel)}?raw`;
  throw new Error(`Markdown path must live under client/: ${repoMarkdownPath}`);
}

/** Split optional YAML-like front matter between --- fences. */
function splitFrontMatter(raw) {
  const t = raw.replace(/^\uFEFF/, "");
  if (!t.startsWith("---")) {
    return { attrs: {}, body: t };
  }
  const nl = t.indexOf("\n");
  if (nl < 0) return { attrs: {}, body: t };
  const rest = t.slice(nl + 1);
  const end = rest.search(/\n---\s*(?:\r?\n|$)/);
  if (end < 0) return { attrs: {}, body: t };
  const fmBlock = rest.slice(0, end).trim();
  const body = rest.slice(end + 1).replace(/^---\s*\r?\n?/, "").replace(/^\s+/, "");
  return { attrs: parseSimpleYaml(fmBlock), body };
}

function parseSimpleYaml(block) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    val = val.replace(/\s+#.*$/, "").trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    attrs[key] = val;
  }
  return attrs;
}

function extractFirstH1(md) {
  const m = md.match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

function parseTags(raw) {
  if (raw == null || raw === "") return undefined;
  const s = String(raw).trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

const COMPONENT_SOURCE_START = "<!-- help:component-source -->";
const COMPONENT_SOURCE_END = "<!-- /help:component-source -->";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {Record<string, string>} attrs */
function tagsArrayFromAttrs(attrs) {
  return parseTags(attrs.tags) ?? [];
}

/** @param {Record<string, string>} attrs */
function hasAutoScaffoldTag(attrs) {
  return tagsArrayFromAttrs(attrs).includes("auto-scaffold");
}

/** @param {Record<string, string>} attrs */
function stringifyFrontMatter(attrs) {
  const lines = ["---"];
  const priority = ["id", "title", "order", "summary", "source", "last_scanned", "tags"];
  const keys = [...new Set([...priority, ...Object.keys(attrs)])].filter((k) => attrs[k] != null && attrs[k] !== "");
  keys.sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    const val = attrs[key];
    if (val === undefined || val === "") continue;
    if (key === "title" || key === "summary") {
      lines.push(`${key}: ${JSON.stringify(String(val))}`);
    } else if (key === "order" && String(val).trim() !== "" && !Number.isNaN(Number(val))) {
      lines.push(`${key}: ${Number.parseInt(String(val), 10)}`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function componentSourceBlock(relSrc) {
  return `${COMPONENT_SOURCE_START}
_Linked component: \`${relSrc}\`._
${COMPONENT_SOURCE_END}`;
}

function syncComponentSourceBlock(body, relSrc) {
  const block = componentSourceBlock(relSrc);
  const wrapped = new RegExp(
    `${escapeRegex(COMPONENT_SOURCE_START)}[\\s\\S]*?${escapeRegex(COMPONENT_SOURCE_END)}`,
    "m",
  );
  if (wrapped.test(body)) {
    return body.replace(wrapped, block);
  }
  const legacyAuto = /^_Auto-generated from `[^`]+` on \d{4}-\d{2}-\d{2}\.[^_\n]*_\s*\n?/m;
  if (legacyAuto.test(body)) {
    return body.replace(legacyAuto, `${block}\n\n`);
  }
  const legacySource = /^_Source file: `[^`]+` — last (?:scanned|synced) \d{4}-\d{2}-\d{2}\._\s*\n?/m;
  if (legacySource.test(body)) {
    return body.replace(legacySource, `${block}\n\n`);
  }
  const legacyLinked = /^_Linked component: `[^`]+`\._\s*\n?/m;
  if (legacyLinked.test(body)) {
    return body.replace(legacyLinked, `${block}\n\n`);
  }
  const m = body.match(/^#[^\n]*\n/);
  if (m && m.index === 0) {
    return body.slice(0, m[0].length) + `\n${block}\n\n` + body.slice(m[0].length);
  }
  return `${block}\n\n${body}`;
}

function absFromRepoPosix(relPosix) {
  const segs = relPosix.split("/").filter(Boolean);
  return path.join(REPO_ROOT, ...segs);
}

function buildComponentManualMarkdown(id, rel, order, today) {
  const title = humanTitleFromComponentPath(rel);
  const relSrc = posix(path.join("client", "src", "components", rel));
  /** @type {Record<string, string>} */
  const attrs = {
    id,
    title,
    order: String(order),
    summary: `Auto-generated stub for ${relSrc} — replace with staff-facing help.`,
    source: relSrc,
    last_scanned: today,
    tags: `${id}, component, auto-scaffold`,
  };
  const block = componentSourceBlock(relSrc);
  return `${stringifyFrontMatter(attrs)}

# ${title}

${block}

## What this is

Briefly describe what staff use this screen for.

## How to use it

1. 
2. 

## Tips

- 

## Screenshots

Add PNGs under \`../images/help/${id}/\` and embed them, for example:

![Example](../images/help/${id}/example.png)

`;
}

function buildComponentIdToPathMap(includeShadcn) {
  const files = listComponentTsxFiles(includeShadcn);
  const relFiles = files.map((f) => posix(path.relative(COMPONENTS_DIR, f)));
  /** @type {Map<string, string>} */
  const idToPath = new Map();
  for (const rel of relFiles) {
    const id = manualIdFromComponentPath(rel);
    if (idToPath.has(id) && idToPath.get(id) !== rel) {
      console.error(
        `Duplicate manual id "${id}" for components:\n  ${idToPath.get(id)}\n  ${rel}\nRename one file or adjust paths.`,
      );
      process.exit(1);
    }
    idToPath.set(id, rel);
  }
  return idToPath;
}

function discoverManuals() {
  const names = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith("-manual.md"))
    .sort();
  if (names.length === 0) {
    throw new Error(
      `No *-manual.md files in ${posix(path.relative(REPO_ROOT, DOCS_DIR))}. Add one or run --scaffold.`,
    );
  }

  /** @type {Array<{id:string,title:string,summary:string,markdown:string,tags?:string[],order:number}>} */
  const manuals = [];
  const seen = new Set();

  for (const file of names) {
    const abs = path.join(DOCS_DIR, file);
    const raw = fs.readFileSync(abs, "utf8");
    const { attrs, body } = splitFrontMatter(raw);
    const baseId = file.replace(/-manual\.md$/i, "").toLowerCase();
    const id = (attrs.id || baseId).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(
        `Invalid manual id "${id}" (from ${file}). Use ^[a-z][a-z0-9-]*$ or set id in front matter.`,
      );
    }
    if (seen.has(id)) throw new Error(`Duplicate help manual id: ${id}`);
    seen.add(id);

    const title = (attrs.title || extractFirstH1(body) || id).trim();
    const summary = attrs.summary != null ? String(attrs.summary).trim() : "";
    const tags = parseTags(attrs.tags);
    let order = 100;
    if (attrs.order != null && String(attrs.order).trim() !== "") {
      const n = Number.parseInt(String(attrs.order), 10);
      if (!Number.isNaN(n)) order = n;
    }

    const markdown = posix(path.join("client", "src", "assets", "docs", file));
    manuals.push({
      id,
      title,
      summary,
      markdown,
      tags: tags?.length ? tags : [id],
      order,
    });
  }

  manuals.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return manuals;
}

function validateManuals(manuals) {
  for (const m of manuals) {
    const abs = path.join(REPO_ROOT, m.markdown);
    if (!fs.existsSync(abs)) {
      throw new Error(`Manual ${m.id}: file not found: ${m.markdown}`);
    }
  }
}

function writeTs(manuals) {
  const imports = manuals.map((m, i) => {
    const imp = importPathFromLibHelpToMarkdown(m.markdown);
    return `import manual_${i}_raw from "${imp}";`;
  });

  const tags = (m) =>
    m.tags?.length ? `,\n    tags: ${JSON.stringify(m.tags)}` : "";

  const summaryLine = (m) => {
    const s = m.summary != null ? String(m.summary).trim() : "";
    return s.length > 0 ? `\n    summary: ${JSON.stringify(s)},` : "";
  };

  const entries = manuals
    .map(
      (m, i) => `  {
    id: ${JSON.stringify(m.id)},
    title: ${JSON.stringify(m.title)},${summaryLine(m)}
    markdown: manual_${i}_raw${tags(m)},
  }`,
    )
    .join(",\n");

  const body = `// @generated by client/scripts/generate-help-manifest.mjs from client/src/assets/docs/*-manual.md — do not edit by hand.
import type { HelpManual } from "./help-manifest.types";

${imports.join("\n")}

export const HELP_MANUALS: HelpManual[] = [
${entries},
];

export function helpManualById(id: string): HelpManual | undefined {
  return HELP_MANUALS.find((m) => m.id === id);
}
`;
  fs.mkdirSync(path.dirname(OUT_TS), { recursive: true });
  fs.writeFileSync(OUT_TS, body, "utf8");
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_TS)}`);
}

function writeRs(manuals) {
  const rows = manuals
    .map((m) => `    (${JSON.stringify(m.id)}, ${JSON.stringify(posix(m.markdown))}),`)
    .join("\n");

  const body = `// @generated by client/scripts/generate-help-manifest.mjs from client/src/assets/docs/*-manual.md — do not edit by hand.

/// \`(manual_id, path relative to repository root)\`
pub const HELP_MANUAL_FILES: &[(&str, &str)] = &[
${rows}
];
`;
  fs.mkdirSync(path.dirname(OUT_RS), { recursive: true });
  fs.writeFileSync(OUT_RS, body, "utf8");
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_RS)}`);
}

function stemToKebab(stem) {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** @param {string} relTsx posix path relative to components/, e.g. pos/Cart.tsx */
function manualIdFromComponentPath(relTsx) {
  const noExt = relTsx.replace(/\.tsx$/i, "");
  const parts = noExt.split("/");
  const fileStem = parts.pop() ?? "";
  const base = stemToKebab(fileStem);
  const folder = parts
    .map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean)
    .join("-");

  let raw =
    folder && base
      ? base.startsWith(`${folder}-`)
        ? base
        : `${folder}-${base}`
      : base || folder;

  if (!raw) raw = "component";

  if (!/^[a-z][a-z0-9-]*$/.test(raw)) {
    const fixed = raw.replace(/^[^a-z]+/, "");
    if (/^[a-z][a-z0-9-]*$/.test(fixed)) return fixed;
    return `component-${fixed || "unknown"}`.replace(/-+/g, "-");
  }
  return raw;
}

function humanTitleFromComponentPath(relTsx) {
  const noExt = relTsx.replace(/\.tsx$/i, "");
  const parts = noExt.split("/");
  const base = parts[parts.length - 1].replace(/([A-Z])/g, " $1").trim();
  if (parts.length <= 1) return base || noExt;
  const area = parts
    .slice(0, -1)
    .map((p) => p.replace(/([A-Z])/g, " $1").trim())
    .join(" / ");
  return `${base} (${area})`;
}

function listComponentTsxFiles(includeShadcn) {
  /** @type {string[]} */
  const out = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!includeShadcn && e.name === "ui-shadcn") continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".tsx") && !e.name.includes(".test.")) {
        out.push(full);
      }
    }
  }
  if (!fs.existsSync(COMPONENTS_DIR)) return out;
  walk(COMPONENTS_DIR);
  return out.sort((a, b) => a.localeCompare(b));
}

function runScaffoldComponents() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const includeShadcn = argv.includes("--include-shadcn");
  const idToPath = buildComponentIdToPathMap(includeShadcn);
  const today = new Date().toISOString().slice(0, 10);
  const existingManuals = fs.existsSync(DOCS_DIR)
    ? new Set(fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith("-manual.md")))
    : new Set();

  let created = 0;
  let skipped = 0;
  const sortedIds = [...idToPath.keys()].sort((a, b) => idToPath.get(a).localeCompare(idToPath.get(b)));

  sortedIds.forEach((id, index) => {
    const rel = idToPath.get(id);
    const fileName = `${id}-manual.md`;
    const absMd = path.join(DOCS_DIR, fileName);
    const absImg = path.join(REPO_ROOT, "client", "src", "assets", "images", "help", id);
    const relSrc = posix(path.join("client", "src", "components", rel));

    if (existingManuals.has(fileName)) {
      skipped += 1;
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] would create ${fileName} <- ${relSrc}`);
      created += 1;
      return;
    }

    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.writeFileSync(absMd, buildComponentManualMarkdown(id, rel, 1000 + index, today), "utf8");
    fs.mkdirSync(absImg, { recursive: true });
    existingManuals.add(fileName);
    created += 1;
    console.log(`Created ${posix(path.relative(REPO_ROOT, absMd))}`);
  });

  console.log(
    `scaffold-components: ${dryRun ? "would create " : ""}${created} file(s), skipped ${skipped} existing (same id-manual.md).`,
  );
}

function runRescanComponents() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const includeShadcn = argv.includes("--include-shadcn");
  const idToPath = buildComponentIdToPathMap(includeShadcn);
  const today = new Date().toISOString().slice(0, 10);
  const sortedIds = [...idToPath.keys()].sort((a, b) => idToPath.get(a).localeCompare(idToPath.get(b)));

  let created = 0;
  let updated = 0;
  let skippedUnchanged = 0;
  let skippedNotTracked = 0;

  for (let index = 0; index < sortedIds.length; index += 1) {
    const id = sortedIds[index];
    const rel = idToPath.get(id);
    const fileName = `${id}-manual.md`;
    const absMd = path.join(DOCS_DIR, fileName);
    const relSrc = posix(path.join("client", "src", "components", rel));
    const absTsx = absFromRepoPosix(relSrc);
    const absImg = path.join(REPO_ROOT, "client", "src", "assets", "images", "help", id);
    const order = 1000 + index;

    if (!fs.existsSync(absTsx)) {
      console.warn(`[rescan] missing on disk (skip): ${relSrc}`);
      continue;
    }

    if (!fs.existsSync(absMd)) {
      if (dryRun) {
        console.log(`[dry-run] would create ${fileName} <- ${relSrc}`);
        created += 1;
      } else {
        fs.mkdirSync(DOCS_DIR, { recursive: true });
        fs.writeFileSync(absMd, buildComponentManualMarkdown(id, rel, order, today), "utf8");
        fs.mkdirSync(absImg, { recursive: true });
        console.log(`Created ${posix(path.relative(REPO_ROOT, absMd))}`);
        created += 1;
      }
      continue;
    }

    const raw = fs.readFileSync(absMd, "utf8");
    const { attrs, body } = splitFrontMatter(raw);
    if (!hasAutoScaffoldTag(attrs)) {
      skippedNotTracked += 1;
      continue;
    }

    const sourceChanged = String(attrs.source || "").trim() !== relSrc;
    const newBody = syncComponentSourceBlock(body, relSrc);
    const norm = (s) => s.replace(/\r\n/g, "\n");
    const bodyChanged = norm(newBody) !== norm(body);

    if (!sourceChanged && !bodyChanged) {
      skippedUnchanged += 1;
      continue;
    }

    /** @type {Record<string, string>} */
    const nextAttrs = { ...attrs, source: relSrc, last_scanned: today };
    const nextRaw = `${stringifyFrontMatter(nextAttrs)}\n\n${newBody.replace(/^\n+/, "")}`;

    if (dryRun) {
      console.log(`[dry-run] would update ${fileName}`);
      updated += 1;
    } else {
      const out = nextRaw.endsWith("\n") ? nextRaw : `${nextRaw}\n`;
      fs.writeFileSync(absMd, out, "utf8");
      fs.mkdirSync(absImg, { recursive: true });
      console.log(`Updated ${posix(path.relative(REPO_ROOT, absMd))}`);
      updated += 1;
    }
  }

  if (fs.existsSync(DOCS_DIR)) {
    for (const f of fs.readdirSync(DOCS_DIR).filter((x) => x.endsWith("-manual.md"))) {
      const baseId = f.replace(/-manual\.md$/i, "").toLowerCase();
      const rawF = fs.readFileSync(path.join(DOCS_DIR, f), "utf8");
      const { attrs: a } = splitFrontMatter(rawF);
      if (!hasAutoScaffoldTag(a)) continue;
      if (!idToPath.has(baseId)) {
        console.warn(
          `[rescan] orphan auto-scaffold manual (no component file maps to id "${baseId}"): ${f}`,
        );
      }
    }
  }

  console.log(
    `rescan-components: ${dryRun ? "dry-run — " : ""}created ${created}, updated ${updated}, skipped ${skippedUnchanged} unchanged, skipped ${skippedNotTracked} (no auto-scaffold tag).`,
  );
}

function runScaffold() {
  const argv = process.argv.slice(2);
  const idIdx = argv.indexOf("--scaffold");
  if (idIdx < 0 || !argv[idIdx + 1]) {
    console.error("Usage: --scaffold <id> --title \"...\" [--markdown client/src/assets/docs/foo.md]");
    process.exit(1);
  }
  const id = argv[idIdx + 1].trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    console.error("id must match ^[a-z][a-z0-9-]*$");
    process.exit(1);
  }
  const titleIdx = argv.indexOf("--title");
  const title =
    titleIdx >= 0 && argv[titleIdx + 1] ? argv[titleIdx + 1].trim() : id;
  const mdIdx = argv.indexOf("--markdown");
  const relFile =
    mdIdx >= 0 && argv[mdIdx + 1]
      ? argv[mdIdx + 1].trim().replace(/^\//, "")
      : `client/src/assets/docs/${id}-manual.md`;
  const fileName = path.basename(relFile);
  if (!fileName.endsWith("-manual.md")) {
    console.error("Markdown filename must end with -manual.md");
    process.exit(1);
  }

  const expectedBase = `${id}-manual.md`;
  if (fileName !== expectedBase) {
    console.error(
      `For id "${id}", expected filename "${expectedBase}", got "${fileName}"`,
    );
    process.exit(1);
  }

  const absMd = path.join(REPO_ROOT, relFile);
  const absImg = path.join(
    REPO_ROOT,
    "client",
    "src",
    "assets",
    "images",
    "help",
    id,
  );

  const existing = fs.existsSync(DOCS_DIR)
    ? fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith("-manual.md"))
    : [];
  for (const f of existing) {
    const other = f.replace(/-manual\.md$/i, "").toLowerCase();
    if (other === id && f !== fileName) {
      console.error(`Id ${id} already used by ${f}`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(absMd)) {
    fs.mkdirSync(path.dirname(absMd), { recursive: true });
    const template = `---
id: ${id}
title: ${JSON.stringify(title)}
order: 100
tags: ${id}
---

# ${title} — staff guide

_Last reviewed: ${new Date().toISOString().slice(0, 10)}_

Short intro for staff. Replace this section.

---

## First section

Steps and tips.

![Example screenshot](../images/help/${id}/example.png)

---

## More help

Screenshots: configure [aidocs-cli](https://github.com/BinarCode/aidocs-cli) to write under \`client/src/assets/images/help/${id}/\`, or copy exports there. Run \`npm run generate:help\` after adding this file or changing front matter.

`;
    fs.writeFileSync(absMd, template, "utf8");
    console.log(`Created ${posix(relFile)}`);
  } else {
    console.log(`Markdown already exists: ${relFile}`);
  }
  fs.mkdirSync(absImg, { recursive: true });
  console.log(`Ensured ${posix(path.relative(REPO_ROOT, absImg))}/`);
}

const argv = process.argv.slice(2);
if (argv.includes("--scaffold")) {
  runScaffold();
}
if (argv.includes("--scaffold-components")) {
  runScaffoldComponents();
}
if (argv.includes("--rescan-components")) {
  runRescanComponents();
}

const manuals = discoverManuals();
validateManuals(manuals);
writeTs(manuals);
writeRs(manuals);
console.log("generate-help-manifest: ok");
