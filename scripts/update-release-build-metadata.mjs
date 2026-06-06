#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, "true");
  }
}

const repo = args.get("repo") ?? process.env.GITHUB_REPOSITORY;
const tag = args.get("tag") ?? process.env.GITHUB_REF_NAME;
const sha = args.get("sha") ?? process.env.GITHUB_SHA;
const runUrl =
  args.get("run-url") ??
  (process.env.GITHUB_SERVER_URL &&
  process.env.GITHUB_REPOSITORY &&
  process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "");
const token = process.env.GITHUB_TOKEN;

if (!repo) throw new Error("Missing --repo or GITHUB_REPOSITORY.");
if (!tag) throw new Error("Missing --tag or GITHUB_REF_NAME.");
if (!sha) throw new Error("Missing --sha or GITHUB_SHA.");
if (!token) throw new Error("Missing GITHUB_TOKEN.");

const shortSha = sha.slice(0, 7);
const now = new Date().toISOString();
const version = tag.startsWith("v") ? tag.slice(1) : tag;
const canonicalNotesPath = path.join("docs", "releases", `${tag}-release-notes.md`);
const fallbackTitle = `Riverside OS ${tag}`;
const buildTitle = `Riverside OS ${tag} — latest build ${shortSha}`;
const startMarker = "<!-- riverside-release-build-meta:start -->";
const endMarker = "<!-- riverside-release-build-meta:end -->";

async function github(pathname, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "riverside-release-metadata-updater",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function baseReleaseBody(existingBody) {
  const bodyFromFile = fs.existsSync(canonicalNotesPath)
    ? fs.readFileSync(canonicalNotesPath, "utf8").trim()
    : "";
  const body = bodyFromFile || existingBody || `${fallbackTitle} release notes.`;
  return body.replace(
    new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\n*`, "m"),
    "",
  ).trim();
}

function buildMetadataBlock(release) {
  const runLine = runUrl ? `- Workflow run: ${runUrl}` : "- Workflow run: not recorded";
  return [
    startMarker,
    "## Latest Build",
    "",
    `- Latest same-version rebuild: ${now}`,
    `- Build commit: ${shortSha}`,
    `- Full commit: ${sha}`,
    `- Release tag: ${tag}`,
    `- Original GitHub publish date: ${release.published_at ?? "unknown"}`,
    runLine,
    "- Note: GitHub's “released X ago” label uses the original publish date; this block records the current rebuilt assets for the same release version.",
    endMarker,
  ].join("\n");
}

const release = await github(`/releases/tags/${encodeURIComponent(tag)}`);
const nextBody = `${baseReleaseBody(release.body)}\n\n${buildMetadataBlock(release)}\n`;

await github(`/releases/${release.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: buildTitle,
    body: nextBody,
    draft: false,
    prerelease: false,
    make_latest: "true",
  }),
});

console.log(`Updated ${tag} release notes/build metadata for ${shortSha}.`);
console.log(`Canonical notes source: ${fs.existsSync(canonicalNotesPath) ? canonicalNotesPath : "existing GitHub release body"}`);
