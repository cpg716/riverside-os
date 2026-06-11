#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: options.env ?? process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? [result.stderr, result.stdout].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${detail ? `\n${detail}` : ""}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function git(args, options = {}) {
  return run("git", args, options);
}

function gh(args, options = {}) {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return run("gh", args, { ...options, env });
}

function repoFromOrigin() {
  const remote = git(["remote", "get-url", "origin"], { capture: true });
  const httpsMatch = remote.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
  if (!httpsMatch) {
    throw new Error(`Could not parse GitHub repository from origin remote: ${remote}`);
  }
  return httpsMatch[1];
}

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tag = process.argv[2] || `v${packageJson.version}`;

if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(tag)) {
  throw new Error(`Release tag must look like v0.90.0 or v0.90.0-rc.1; received ${tag}`);
}

const branch = git(["branch", "--show-current"], { capture: true });
if (branch !== "main") {
  throw new Error(`release:retag must run from main; current branch is ${branch || "(detached)"}.`);
}

const dirty = git(["status", "--porcelain"], { capture: true });
if (dirty.trim()) {
  throw new Error(`release:retag requires a clean workspace. Commit or discard these changes first:\n${dirty}`);
}

const head = git(["rev-parse", "HEAD"], { capture: true });
const shortHead = head.slice(0, 7);
const notesFile = path.join("docs", "releases", `${tag}-release-notes.md`);
if (!fs.existsSync(notesFile)) {
  throw new Error(`Release notes file not found: ${notesFile}`);
}

console.log(`[release:retag] Running pre-retag gate for ${tag} at ${shortHead}...`);
run("npm", ["run", "check:pre-retag"]);

const repo = repoFromOrigin();
console.log(`[release:retag] Pushing main to origin...`);
git(["push", "origin", "main"]);

console.log(`[release:retag] Moving ${tag} to ${shortHead}...`);
git(["tag", "-f", tag, head]);
git(["push", "--force", "origin", `refs/tags/${tag}`]);

const title = `Riverside OS ${tag} - latest build ${shortHead}`;
const releaseExists = spawnSync(
  "gh",
  ["release", "view", tag, "--repo", repo],
  {
    encoding: "utf8",
    stdio: "ignore",
    env: (() => {
      const env = { ...process.env };
      delete env.GITHUB_TOKEN;
      delete env.GH_TOKEN;
      return env;
    })(),
  },
);

if (releaseExists.status === 0) {
  console.log(`[release:retag] Updating existing GitHub Release ${tag}...`);
  gh([
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--title",
    title,
    "--notes-file",
    notesFile,
    "--target",
    head,
    "--verify-tag",
    "--draft=false",
    "--prerelease=false",
    "--latest",
  ]);
} else {
  console.log(`[release:retag] Creating GitHub Release ${tag}...`);
  gh([
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--target",
    head,
    "--title",
    title,
    "--notes-file",
    notesFile,
    "--latest",
  ]);
}

console.log(`[release:retag] ${tag} now points to ${head}.`);
