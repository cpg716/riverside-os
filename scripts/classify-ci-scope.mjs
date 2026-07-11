#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key.startsWith("--") || !value || value.startsWith("--")) continue;
  args.set(key.slice(2), value);
  index += 1;
}

const companionDirectories = [
  "counterpoint-bridge",
  "deployment/counterpoint-bridge-gui",
  "deployment/manager-app",
  "deployment/server-manager-app",
  "ros-dev",
  "tools/counterpoint-bridge",
];
const dependencyManifestNames = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
]);

function changedFiles() {
  const explicitFiles = args.get("files-json");
  if (explicitFiles) return JSON.parse(explicitFiles);

  const base = args.get("base");
  const head = args.get("head");
  if (!base || !head) return [];

  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    encoding: "utf8",
  })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function companionDirectoryFor(file) {
  return companionDirectories.find((directory) => {
    if (!file.startsWith(`${directory}/`)) return false;
    const relativePath = file.slice(directory.length + 1);
    return dependencyManifestNames.has(relativePath);
  });
}

const eventName = args.get("event") ?? "";
const actor = args.get("actor") ?? "";
const isDependabotPullRequest =
  eventName === "pull_request" && actor === "dependabot[bot]";

let files = [];
let selectedDirectories = [];
let fullStack = true;

if (isDependabotPullRequest) {
  files = changedFiles();
  selectedDirectories = [
    ...new Set(files.map(companionDirectoryFor).filter(Boolean)),
  ].sort();
  fullStack =
    files.length === 0 ||
    selectedDirectories.length === 0 ||
    files.some((file) => !companionDirectoryFor(file));
}

const outputs = {
  full_stack: String(fullStack),
  companion_directories: JSON.stringify(fullStack ? [] : selectedDirectories),
};

const githubOutput = args.get("github-output");
if (githubOutput) {
  appendFileSync(
    githubOutput,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

console.log(
  JSON.stringify(
    {
      eventName,
      actor,
      files,
      fullStack,
      companionDirectories: fullStack ? [] : selectedDirectories,
    },
    null,
    2,
  ),
);
