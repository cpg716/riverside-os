#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1]?.trim() : "";
};
const rootArg = valueAfter("--root");
const expectedSha = valueAfter("--sha");
if (!rootArg || !expectedSha) throw new Error("--root and --sha are required.");
const root = path.resolve(rootArg);
if (!fs.existsSync(root)) throw new Error(`Candidate root does not exist: ${root}.`);

const requiredManifests = [
  "riverside-updater-build-manifest.json",
  "riverside-deployment-manager-updater-build-manifest.json",
  "ros-server-manager-updater-build-manifest.json",
  "counterpoint-bridge-gui-updater-build-manifest.json",
  "ros-dev-center-updater-build-manifest.json",
];

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(fullPath) : [fullPath];
  });
}

const files = filesBelow(root);
const byName = new Map(files.map((file) => [path.basename(file), file]));
for (const name of requiredManifests) {
  const manifestPath = byName.get(name);
  if (!manifestPath) throw new Error(`Candidate is missing ${name}.`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.sourceGitSha !== expectedSha) {
    throw new Error(`${name} was built from ${manifest.sourceGitSha ?? "unknown"}, not ${expectedSha}.`);
  }
  for (const assetKey of ["asset", "signatureAsset"]) {
    const asset = manifest[assetKey];
    if (asset && !byName.has(asset)) throw new Error(`${name} references missing ${assetKey} ${asset}.`);
  }
}

const shortSha = expectedSha.slice(0, 8);
const deploymentZips = files.filter((file) => path.basename(file).endsWith("-Windows-Deployment.zip"));
if (deploymentZips.length !== 1 || !path.basename(deploymentZips[0]).includes(`-${shortSha}-`)) {
  throw new Error(`Expected one Windows deployment ZIP for ${shortSha}; found ${deploymentZips.map(path.basename).join(", ") || "none"}.`);
}
console.log(`Candidate assets verified for ${expectedSha}: ${files.length} files and ${requiredManifests.length} build manifests.`);
