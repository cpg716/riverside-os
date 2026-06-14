import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const token = "test-sync-token";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workbenchRoot = path.resolve(__dirname, "..");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 5_000) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return await res.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw lastError ?? new Error("Workbench did not start");
}

async function startWorkbench(t) {
  const port = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-sync-test-"));
  const storePath = path.join(tmpDir, "store.json");
  const dbPath = path.join(tmpDir, "store.sqlite");
  const child = spawn(process.execPath, ["index.mjs"], {
    cwd: workbenchRoot,
    env: {
      ...process.env,
      COUNTERPOINT_SYNC_WORKBENCH_HOST: "127.0.0.1",
      COUNTERPOINT_SYNC_WORKBENCH_PORT: String(port),
      COUNTERPOINT_SYNC_WORKBENCH_TOKEN: token,
      COUNTERPOINT_SYNC_WORKBENCH_STORE: storePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { baseUrl, storePath, dbPath, output: () => output };
}

async function api(baseUrl, method, pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "x-counterpoint-sync-token": token,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

test("Workbench blocks ready state for unresolved blockers and keeps package metadata stable", async (t) => {
  const { baseUrl } = await startWorkbench(t);
  const runId = "11111111-1111-4111-8111-111111111111";
  const batch = {
    sync_run_id: runId,
    source_batch_id: "batch_customers_1",
    section: "customers",
    payload: { rows: [{ cust_no: "C1", email: "dup@example.test" }] },
    exceptions: [{
      severity: "blocker",
      code: "duplicate_customer_email",
      message: "Duplicate email requires review.",
      source_record_id: "C1",
      original_value: "dup@example.test",
      recommended_action: "Clear or map email before import.",
    }],
  };
  assert.equal((await api(baseUrl, "POST", "/api/bridge/batches", batch)).res.status, 200);
  const ready = await api(baseUrl, "POST", `/api/runs/${runId}/sections/customers/mark-ready`, { approved_by: "test" });
  assert.equal(ready.res.status, 409);

  const first = await api(baseUrl, "GET", `/api/runs/${runId}/packages/customers`);
  const second = await api(baseUrl, "GET", `/api/runs/${runId}/packages/customers`);
  assert.equal(first.data.package_fingerprint, second.data.package_fingerprint);
  assert.equal(first.data.generated_at, second.data.generated_at);
  assert.equal(first.data.source_counts.blockers, 1);
});

test("SQLite store initializes, health reports schema, and export includes portable data", async (t) => {
  const { baseUrl, dbPath } = await startWorkbench(t);
  const runId = "22222222-2222-4222-8222-222222222222";
  assert.equal((await api(baseUrl, "POST", "/api/bridge/heartbeat", { bridge_hostname: "test" })).res.status, 200);
  assert.equal((await api(baseUrl, "POST", "/api/bridge/batches", {
    sync_run_id: runId,
    source_batch_id: "batch_vendors_1",
    section: "vendors",
    payload: { rows: [{ vendor_code: "V1", name: "Vendor 1" }] },
  })).res.status, 200);
  assert.ok(fs.existsSync(dbPath));
  assert.ok(fs.existsSync(`${dbPath}.bak`));

  const health = await fetch(`${baseUrl}/health`).then((res) => res.json());
  assert.equal(health.store_type, "sqlite");
  assert.equal(health.store.type, "sqlite");
  assert.equal(health.store.format_version, 1);
  assert.equal(health.store.exists, true);

  const exported = await api(baseUrl, "GET", "/api/export");
  assert.equal(exported.data.schema_version, 1);
  assert.equal(exported.data.store_type, "sqlite");
  assert.equal(exported.data.store.schema_version, 1);
  assert.ok(Array.isArray(exported.data.store.runs));
});

test("Existing JSON store migrates into SQLite without deleting original JSON", async (t) => {
  const port = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-sync-migrate-"));
  const storePath = path.join(tmpDir, "store.json");
  const dbPath = path.join(tmpDir, "store.sqlite");
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 1,
    runs: [{
      sync_run_id: "44444444-4444-4444-8444-444444444444",
      name: "Migrated JSON run",
      status: "raw",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      sections: {},
      source_batches: [],
      exceptions: [],
      provenance: [],
      packages: {},
    }],
    heartbeats: [],
    status_events: [],
  }));
  const child = spawn(process.execPath, ["index.mjs"], {
    cwd: workbenchRoot,
    env: {
      ...process.env,
      COUNTERPOINT_SYNC_WORKBENCH_HOST: "127.0.0.1",
      COUNTERPOINT_SYNC_WORKBENCH_PORT: String(port),
      COUNTERPOINT_SYNC_WORKBENCH_TOKEN: token,
      COUNTERPOINT_SYNC_WORKBENCH_STORE: storePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl);
  assert.equal(health.store.migration_status.status, "migrated_from_json");
  assert.ok(fs.existsSync(storePath));
  assert.ok(fs.existsSync(dbPath));
  const runs = await api(baseUrl, "GET", "/api/runs");
  assert.equal(runs.data.runs[0].sync_run_id, "44444444-4444-4444-8444-444444444444");
});

test("No-hardware simulator creates deterministic section packages and is idempotent by source batch", async (t) => {
  const { baseUrl, storePath } = await startWorkbench(t);
  const env = {
    ...process.env,
    COUNTERPOINT_SYNC_WORKBENCH_URL: baseUrl,
    COUNTERPOINT_SYNC_WORKBENCH_TOKEN: token,
    COUNTERPOINT_SYNC_WORKBENCH_STORE: storePath,
  };
  const runSimulator = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/simulate-counterpoint.mjs"], {
      cwd: workbenchRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output));
    });
  });

  const firstOutput = JSON.parse(await runSimulator());
  const secondOutput = JSON.parse(await runSimulator());
  const firstCustomers = firstOutput.sections.find((section) => section.section === "customers");
  const secondCustomers = secondOutput.sections.find((section) => section.section === "customers");
  const inventory = secondOutput.sections.find((section) => section.section === "inventory");
  assert.equal(firstCustomers?.fingerprint, secondCustomers?.fingerprint);
  assert.equal(inventory?.blockers, 1);

  const runs = await api(baseUrl, "GET", "/api/runs");
  assert.equal(runs.data.runs[0].source_batches, 5);
});

test("Simulation cleanup removes only simulator runs and keeps real run data", async (t) => {
  const { baseUrl, storePath, dbPath } = await startWorkbench(t);
  const env = {
    ...process.env,
    COUNTERPOINT_SYNC_WORKBENCH_URL: baseUrl,
    COUNTERPOINT_SYNC_WORKBENCH_TOKEN: token,
    COUNTERPOINT_SYNC_WORKBENCH_STORE: storePath,
  };
  const runScript = (script, args = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: workbenchRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output));
    });
  });

  await runScript("scripts/simulate-counterpoint.mjs");
  assert.equal((await api(baseUrl, "POST", "/api/bridge/batches", {
    sync_run_id: "33333333-3333-4333-8333-333333333333",
    source_batch_id: "real_vendors_1",
    section: "vendors",
    source_system: "counterpoint_bridge",
    payload: { rows: [{ vendor_code: "REAL", name: "Real Vendor" }] },
  })).res.status, 200);

  const dryRun = JSON.parse(await runScript("scripts/clear-simulation-data.mjs", ["--dry-run"]));
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.removed_runs, 1);

  const cleared = JSON.parse(await runScript("scripts/clear-simulation-data.mjs"));
  assert.equal(cleared.removed_runs, 1);
  assert.ok(fs.existsSync(`${dbPath}.bak`));

  const runs = await api(baseUrl, "GET", "/api/runs");
  assert.equal(runs.data.runs.length, 1);
  assert.equal(runs.data.runs[0].sync_run_id, "33333333-3333-4333-8333-333333333333");
});

test("AI review suggestions are review-first and accepted suggestions change prepared package only", async (t) => {
  const { baseUrl } = await startWorkbench(t);
  const runId = "55555555-5555-4555-8555-555555555555";
  assert.equal((await api(baseUrl, "POST", "/api/bridge/batches", {
    sync_run_id: runId,
    source_batch_id: "catalog_ai_1",
    section: "catalog",
    payload: { rows: [{ source_record_id: "ITEM-1", item_no: "ITEM-1", description: "BLU SLD SHT", category: "shirts" }] },
    original_payload: { rows: [{ source_record_id: "ITEM-1", item_no: "ITEM-1", description: "BLU SLD SHT", category: "shirts" }] },
  })).res.status, 200);

  const reviewExport = await api(baseUrl, "POST", `/api/runs/${runId}/sections/catalog/ai-review/export`, {
    review_type: "full_section_review",
    records_mode: "full",
  });
  assert.equal(reviewExport.res.status, 200);
  const reviewPackage = reviewExport.data.review_package;
  assert.ok(reviewPackage.instructions.join(" ").includes("review-only"));
  assert.ok(reviewPackage.allowed_suggestion_schema);

  const badImport = await api(baseUrl, "POST", "/api/ai-review/import-suggestions", {
    review_package_id: reviewPackage.review_package_id,
    sync_run_id: runId,
    section: "catalog",
    package_fingerprint: "wrong",
    suggestions: [],
  });
  assert.equal(badImport.res.status, 400);

  const imported = await api(baseUrl, "POST", "/api/ai-review/import-suggestions", {
    review_package_id: reviewPackage.review_package_id,
    sync_run_id: runId,
    section: "catalog",
    package_fingerprint: reviewPackage.package_fingerprint,
    suggestions: [{
      suggestion_type: "description_readability",
      source_record_id: "ITEM-1",
      target_path: "payload.rows[0].description",
      current_value: "BLU SLD SHT",
      suggested_value: "Blue Solid Shirt",
      reason: "Expands abbreviations for staff-readable product description.",
      confidence: "high",
      risk_level: "low",
    }],
  });
  assert.equal(imported.res.status, 200);
  assert.equal(imported.data.imported, 1);

  const suggestions = await api(baseUrl, "GET", `/api/runs/${runId}/ai-review/suggestions`);
  const suggestion = suggestions.data.suggestions[0];
  assert.equal(suggestion.status, "pending");

  const decision = await api(baseUrl, "POST", `/api/ai-review/suggestions/${suggestion.suggestion_id}/decision`, {
    decision: "accept",
    reviewed_by: "test",
  });
  assert.equal(decision.res.status, 200);

  const applied = await api(baseUrl, "POST", `/api/runs/${runId}/sections/catalog/ai-review/apply-accepted`);
  assert.equal(applied.res.status, 200);
  assert.equal(applied.data.applied, 1);
  assert.notEqual(applied.data.package_fingerprint, reviewPackage.package_fingerprint);

  const packageAfter = await api(baseUrl, "GET", `/api/runs/${runId}/packages/catalog`);
  assert.equal(packageAfter.data.payload.rows[0].description, "Blue Solid Shirt");
  assert.equal(packageAfter.data.provenance[0].original_payload.rows[0].description, "BLU SLD SHT");
});
