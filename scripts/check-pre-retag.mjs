#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const steps = [
  {
    label: "version parity",
    command: "npm",
    args: ["run", "check:version"],
  },
  {
    label: "deployment release gates",
    command: "npm",
    args: ["run", "check:deployment-release"],
  },
  {
    label: "go-live blocker gates",
    command: "npm",
    args: ["run", "check:go-live-blockers"],
  },
  {
    label: "print routing manifest",
    command: "npm",
    args: ["run", "check:print-routing"],
  },
  {
    label: "dirty existing-database migration rehearsal",
    command: "node",
    args: ["scripts/check-dirty-migration-rehearsal.mjs"],
  },
  {
    label: "server rustfmt",
    command: "cargo",
    args: ["fmt", "--manifest-path", "server/Cargo.toml", "--check"],
  },
  {
    label: "server migration parser tests",
    command: "cargo",
    args: ["test", "--manifest-path", "server/Cargo.toml", "db_migrations::tests", "--lib"],
  },
  {
    label: "client typecheck",
    command: "npm",
    args: ["--prefix", "client", "run", "typecheck"],
  },
  {
    label: "client lint",
    command: "npm",
    args: ["run", "lint"],
  },
  {
    label: "whitespace diff check",
    command: "git",
    args: ["diff", "--check"],
  },
];

for (const step of steps) {
  console.log(`\n[pre-retag] ${step.label}`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`[pre-retag] ${step.label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[pre-retag] ${step.label} failed with exit code ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n[pre-retag] All gates passed.");
