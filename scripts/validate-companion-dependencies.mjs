#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key.startsWith("--") || !value || value.startsWith("--")) continue;
  args.set(key.slice(2), value);
  index += 1;
}

const allowedDirectories = new Set([
  "counterpoint-bridge",
  "deployment/counterpoint-bridge-gui",
  "deployment/manager-app",
  "deployment/server-manager-app",
  "ros-dev",
  "tools/counterpoint-bridge",
]);
const directories = JSON.parse(args.get("directories-json") ?? "[]");

if (!Array.isArray(directories) || directories.length === 0) {
  throw new Error("No companion dependency directories were provided.");
}

for (const directory of directories) {
  if (!allowedDirectories.has(directory)) {
    throw new Error(`Unsupported companion dependency directory: ${directory}`);
  }

  const packageJsonPath = join(directory, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  console.log(`Installing locked dependencies in ${directory}...`);
  execFileSync("npm", ["ci"], { cwd: directory, stdio: "inherit" });

  if (packageJson.scripts?.build) {
    console.log(`Building ${directory}...`);
    execFileSync("npm", ["run", "build"], { cwd: directory, stdio: "inherit" });
    continue;
  }

  const entrypoint = join(directory, "index.mjs");
  if (!existsSync(entrypoint)) {
    throw new Error(`No build script or index.mjs validation target in ${directory}.`);
  }

  console.log(`Checking JavaScript syntax in ${entrypoint}...`);
  execFileSync(process.execPath, ["--check", "index.mjs"], {
    cwd: directory,
    stdio: "inherit",
  });
}
