import fs from "fs";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function readCargoPackageVersion(path) {
  const content = fs.readFileSync(path, "utf8");
  const match = content.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Could not find package version in ${path}`);
  }
  return match[1];
}

const versions = [
  ["package.json", readJson("package.json").version],
  ["client/package.json", readJson("client/package.json").version],
  ["client/src-tauri/tauri.conf.json", readJson("client/src-tauri/tauri.conf.json").version],
  ["server/Cargo.toml", readCargoPackageVersion("server/Cargo.toml")],
  ["client/src-tauri/Cargo.toml", readCargoPackageVersion("client/src-tauri/Cargo.toml")],
  ["ros-dev/package.json", readJson("ros-dev/package.json").version],
  ["ros-dev/src-tauri/tauri.conf.json", readJson("ros-dev/src-tauri/tauri.conf.json").version],
  ["ros-dev/src-tauri/Cargo.toml", readCargoPackageVersion("ros-dev/src-tauri/Cargo.toml")],
  ["deployment/manager-app/package.json", readJson("deployment/manager-app/package.json").version],
  ["deployment/manager-app/src-tauri/tauri.conf.json", readJson("deployment/manager-app/src-tauri/tauri.conf.json").version],
  ["deployment/manager-app/src-tauri/Cargo.toml", readCargoPackageVersion("deployment/manager-app/src-tauri/Cargo.toml")],
];

const expected = versions[0][1];
const mismatches = versions.filter(([, version]) => version !== expected);

if (mismatches.length > 0) {
  console.error("Riverside version mismatch:");
  for (const [path, version] of versions) {
    console.error(`- ${path}: ${version}`);
  }
  process.exit(1);
}

console.log(`Riverside version parity OK: ${expected}`);
