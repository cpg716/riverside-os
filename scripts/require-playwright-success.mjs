#!/usr/bin/env node

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
const sha = args.get("sha") ?? process.env.GITHUB_SHA;
const workflow = args.get("workflow") ?? "playwright-e2e.yml";
const timeoutMinutes = Number(args.get("timeout-minutes") ?? "45");
const pollSeconds = Number(args.get("poll-seconds") ?? "30");
const token = process.env.GITHUB_TOKEN;

if (!repo) throw new Error("Missing --repo or GITHUB_REPOSITORY.");
if (!sha) throw new Error("Missing --sha or GITHUB_SHA.");
if (!token) throw new Error("Missing GITHUB_TOKEN.");
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  throw new Error("--timeout-minutes must be a positive number.");
}
if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
  throw new Error("--poll-seconds must be a positive number.");
}

const apiBase = `https://api.github.com/repos/${repo}`;
const workflowId = encodeURIComponent(workflow);
const deadline = Date.now() + timeoutMinutes * 60_000;

async function github(path) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "riverside-release-playwright-gate",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortNewestFirst(runs) {
  return [...runs].sort((left, right) => {
    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });
}

while (Date.now() < deadline) {
  const data = await github(
    `/actions/workflows/${workflowId}/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`,
  );
  const runs = sortNewestFirst(data.workflow_runs ?? []);
  const activeRun = runs.find((run) => run.status !== "completed");
  const completedRun = runs.find((run) => run.status === "completed");

  if (activeRun) {
    console.log(
      `Playwright E2E run ${activeRun.id} is ${activeRun.status}; waiting for ${sha}.`,
    );
    await sleep(pollSeconds * 1000);
    continue;
  }

  if (completedRun) {
    if (completedRun.conclusion === "success") {
      console.log(`Playwright E2E passed for ${sha}: ${completedRun.html_url}`);
      process.exit(0);
    }
    throw new Error(
      `Playwright E2E ${completedRun.conclusion} for ${sha}: ${completedRun.html_url}`,
    );
  }

  console.log(`No Playwright E2E run found yet for ${sha}; waiting.`);
  await sleep(pollSeconds * 1000);
}

throw new Error(
  `Timed out after ${timeoutMinutes} minutes waiting for Playwright E2E on ${sha}.`,
);
