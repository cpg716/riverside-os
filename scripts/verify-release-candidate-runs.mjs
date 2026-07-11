#!/usr/bin/env node

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
  args.set(key.slice(2), value.trim());
}

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const windowsRunId = args.get("windows-run-id");
const macosRunId = args.get("macos-run-id");
const tag = args.get("tag");
if (!repository || !token || !windowsRunId || !macosRunId || !tag) {
  throw new Error("GITHUB_REPOSITORY, GITHUB_TOKEN, --windows-run-id, --macos-run-id, and --tag are required.");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}: ${await response.text()}`);
  return response.json();
}

async function resolveTagSha() {
  const ref = await api(`/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref.object;
  while (object.type === "tag") object = (await api(`/git/tags/${object.sha}`)).object;
  if (object.type !== "commit") throw new Error(`Release tag ${tag} resolves to ${object.type}, not a commit.`);
  return object.sha;
}

async function verifyRun(runId, workflowPath, requiredArtifacts) {
  const run = await api(`/actions/runs/${encodeURIComponent(runId)}`);
  if (run.path !== workflowPath) throw new Error(`Run ${runId} used ${run.path}, not ${workflowPath}.`);
  if (run.event !== "workflow_dispatch") throw new Error(`Run ${runId} was ${run.event}, not workflow_dispatch.`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`Run ${runId} is ${run.status}/${run.conclusion ?? "unknown"}, not completed/success.`);
  }

  const response = await api(`/actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=100`);
  const artifacts = new Map(response.artifacts.map((artifact) => [artifact.name, artifact]));
  for (const name of requiredArtifacts) {
    const artifact = artifacts.get(name);
    if (!artifact) throw new Error(`Run ${runId} is missing required artifact ${name}.`);
    if (artifact.expired) throw new Error(`Run ${runId} artifact ${name} has expired.`);
    if (!artifact.digest?.startsWith("sha256:")) {
      throw new Error(`Run ${runId} artifact ${name} has no GitHub SHA-256 digest.`);
    }
  }
  return run;
}

const windowsArtifacts = [
  "riverside-windows-deployment-package",
  "tauri-windows-updater-dist",
  "deployment-manager-bundle",
  "deployment-manager-updater-dist",
  "server-manager-bundle",
  "server-manager-updater-dist",
  "counterpoint-bridge-gui-bundle",
  "counterpoint-bridge-gui-updater-dist",
];
const macosArtifacts = ["ros-dev-center-macos-release-candidate"];

const [tagSha, windowsRun, macosRun] = await Promise.all([
  resolveTagSha(),
  verifyRun(windowsRunId, ".github/workflows/windows-deployment-package.yml", windowsArtifacts),
  verifyRun(macosRunId, ".github/workflows/macos-ros-dev-center-release.yml", macosArtifacts),
]);
if (windowsRun.head_sha !== macosRun.head_sha) {
  throw new Error(`Candidate SHA mismatch: Windows ${windowsRun.head_sha}, macOS ${macosRun.head_sha}.`);
}
if (windowsRun.head_sha !== tagSha) {
  throw new Error(`Release tag ${tag} targets ${tagSha}, not candidate commit ${windowsRun.head_sha}.`);
}

if (process.env.GITHUB_OUTPUT) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${tagSha}\nsource_short=${tagSha.slice(0, 8)}\n`);
}
console.log(`Release candidates verified: ${tag} -> ${tagSha}; Windows run ${windowsRunId}; macOS run ${macosRunId}.`);
