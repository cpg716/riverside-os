import fs from "node:fs";

const tagArgIndex = process.argv.indexOf("--tag");
let tag = tagArgIndex >= 0 ? process.argv[tagArgIndex + 1]?.trim() : "";
if (!tag) {
  const pkg = JSON.parse(fs.readFileSync(new URL("../client/package.json", import.meta.url), "utf8"));
  tag = `v${pkg.version}`;
}

const repository = process.env.GITHUB_REPOSITORY;
const expectedSha = process.env.GITHUB_SHA;
const token = process.env.GITHUB_TOKEN;
if (!repository || !expectedSha || !token) {
  throw new Error("GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_TOKEN are required.");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} while resolving ${tag}: ${await response.text()}`);
  }
  return response.json();
}

const ref = await api(`/git/ref/tags/${encodeURIComponent(tag)}`);
let object = ref.object;
while (object.type === "tag") {
  object = (await api(`/git/tags/${object.sha}`)).object;
}
if (object.type !== "commit" || object.sha !== expectedSha) {
  throw new Error(`Release tag ${tag} targets ${object.sha} (${object.type}), not workflow commit ${expectedSha}.`);
}
console.log(`Release provenance verified: ${tag} -> ${expectedSha}`);
