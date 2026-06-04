#!/usr/bin/env node

const args = process.argv.slice(2);

function valuesFor(flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function valueFor(flag, fallback = "") {
  return valuesFor(flag).at(-1) ?? fallback;
}

function assetNameFromUrl(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? "");
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value.trim();
}

const repo = valueFor("--repo", process.env.GITHUB_REPOSITORY ?? "");
const tag = valueFor("--tag", process.env.TAG ?? process.env.RELEASE_TAG ?? "");
const platform = valueFor("--platform", "");
const manifests = valuesFor("--manifest");
const buildManifests = valuesFor("--build-manifest");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

if (!repo.includes("/")) {
  throw new Error("--repo must be owner/name or GITHUB_REPOSITORY must be set");
}
if (!tag) {
  throw new Error("--tag or TAG/RELEASE_TAG must be set");
}
if (manifests.length === 0) {
  throw new Error("At least one --manifest is required");
}

const apiHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "RiversideOS-Updater-Release-Verifier",
};
if (token) {
  apiHeaders.Authorization = `Bearer ${token}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: apiHeaders });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchAssetText(asset) {
  const response = await fetch(asset.url, {
    headers: {
      ...apiHeaders,
      Accept: "application/octet-stream",
    },
  });
  if (!response.ok) {
    throw new Error(`Asset ${asset.name} returned HTTP ${response.status}`);
  }
  return response.text();
}

const releasePath =
  tag === "latest"
    ? `https://api.github.com/repos/${repo}/releases/latest`
    : `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
const release = await fetchJson(releasePath);
const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));

function requireAsset(name, context) {
  const asset = assets.get(name);
  if (!asset) {
    throw new Error(`${context} references missing release asset: ${name}`);
  }
  if (!Number.isFinite(asset.size) || asset.size <= 0) {
    throw new Error(`${context} release asset is empty: ${name}`);
  }
  return asset;
}

function manifestTargets(manifest, manifestName) {
  if (manifest.platforms && typeof manifest.platforms === "object") {
    if (platform) {
      const target = manifest.platforms[platform];
      if (!target) {
        throw new Error(`${manifestName} is missing platform ${platform}`);
      }
      return [[platform, target]];
    }
    return Object.entries(manifest.platforms);
  }
  return [["default", manifest]];
}

async function validateManifest(manifestName) {
  const asset = requireAsset(manifestName, "manifest");
  const manifest = JSON.parse(await fetchAssetText(asset));
  const version = requireString(manifest.version, `${manifestName}.version`);
  if (!version.includes("+")) {
    throw new Error(`${manifestName}.version must include +build metadata`);
  }
  requireString(manifest.build_sha, `${manifestName}.build_sha`);

  for (const [targetName, target] of manifestTargets(manifest, manifestName)) {
    const signature = requireString(
      target.signature,
      `${manifestName}.${targetName}.signature`,
    );
    if (signature.length < 32) {
      throw new Error(`${manifestName}.${targetName}.signature is too short`);
    }

    const url = requireString(target.url, `${manifestName}.${targetName}.url`);
    const updateAssetName = assetNameFromUrl(url);
    requireAsset(updateAssetName, `${manifestName}.${targetName}.url`);
    requireAsset(`${updateAssetName}.sig`, `${manifestName}.${targetName}.url`);
  }

  console.log(`ok manifest ${manifestName}`);
}

async function validateBuildManifest(manifestName) {
  const asset = requireAsset(manifestName, "build manifest");
  const manifest = JSON.parse(await fetchAssetText(asset));
  const updaterVersion = requireString(
    manifest.updaterVersion,
    `${manifestName}.updaterVersion`,
  );
  if (!updaterVersion.includes("+")) {
    throw new Error(`${manifestName}.updaterVersion must include +build metadata`);
  }
  requireString(manifest.sourceGitSha, `${manifestName}.sourceGitSha`);
  const updateAssetName = requireString(manifest.asset, `${manifestName}.asset`);
  requireAsset(updateAssetName, `${manifestName}.asset`);
  requireAsset(
    manifest.signatureAsset || `${updateAssetName}.sig`,
    `${manifestName}.signatureAsset`,
  );
  console.log(`ok build manifest ${manifestName}`);
}

for (const manifest of manifests) {
  await validateManifest(manifest);
}

for (const manifest of buildManifests) {
  await validateBuildManifest(manifest);
}

console.log(`Updater release assets verified for ${repo} ${tag}`);
