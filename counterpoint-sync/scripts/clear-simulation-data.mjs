#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
loadEnv(path.join(rootDir, ".env"));

const jsonStorePath = path.resolve(
  rootDir,
  process.env.COUNTERPOINT_SYNC_WORKBENCH_STORE ?? "./data/sync-workbench-store.json",
);
const sqliteStorePath = path.resolve(
  rootDir,
  process.env.COUNTERPOINT_SYNC_WORKBENCH_DB ??
    (jsonStorePath.endsWith(".json") ? jsonStorePath.replace(/\.json$/u, ".sqlite") : `${jsonStorePath}.sqlite`),
);
const simRunId = process.env.COUNTERPOINT_SYNC_SIM_RUN_ID ?? deterministicUuid("riverside-counterpoint-sync-simulation-v1");
const simSourceSystem = "counterpoint_bridge_simulator";
const dryRun = process.argv.includes("--dry-run");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim();
  }
}

function deterministicUuid(seed) {
  const hash = crypto.createHash("sha256").update(seed).digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isSimulationRun(run) {
  if (run.sync_run_id === simRunId) return true;
  const batches = Array.isArray(run.source_batches) ? run.source_batches : [];
  return batches.length > 0 && batches.every((batch) => batch.source_system === simSourceSystem);
}

function clearSqlite() {
  const db = new DatabaseSync(sqliteStorePath);
  try {
    const rows = db.prepare("SELECT sync_run_id, run_json FROM sync_runs").all();
    const removedRuns = rows
      .map((row) => JSON.parse(row.run_json))
      .filter(isSimulationRun);
    const removedRunIds = removedRuns.map((run) => run.sync_run_id);
    if (!dryRun && removedRunIds.length > 0) {
      fs.copyFileSync(sqliteStorePath, `${sqliteStorePath}.bak`);
      db.exec("BEGIN IMMEDIATE");
      try {
        const placeholders = removedRunIds.map(() => "?").join(",");
        for (const table of [
          "sync_runs",
          "sync_run_sections",
          "sync_source_batches",
          "sync_packages",
          "sync_exceptions",
          "sync_provenance",
          "sync_ai_review_packages",
          "sync_ai_suggestions",
          "sync_status_events",
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE sync_run_id IN (${placeholders})`).run(...removedRunIds);
        }
        db.prepare("DELETE FROM sync_bridge_heartbeats WHERE json_extract(payload_json, '$.bridge_hostname') = 'counterpoint-simulator'").run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return {
      ok: true,
      store_type: "sqlite",
      dry_run: dryRun,
      store_path: sqliteStorePath,
      backup_path: dryRun ? null : `${sqliteStorePath}.bak`,
      removed_runs: removedRunIds.length,
      removed_run_ids: removedRunIds,
      remaining_runs: rows.length - removedRunIds.length,
    };
  } finally {
    db.close();
  }
}

function atomicWriteJson(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = JSON.stringify(store, null, 2);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, data);
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  fs.renameSync(tmpPath, filePath);
}

function clearLegacyJson() {
  if (!fs.existsSync(jsonStorePath)) {
    return { ok: true, store_type: "none", store_path: sqliteStorePath, removed_runs: 0, message: "Store file does not exist." };
  }
  const store = JSON.parse(fs.readFileSync(jsonStorePath, "utf8"));
  const beforeRuns = Array.isArray(store.runs) ? store.runs : [];
  const removed = beforeRuns.filter(isSimulationRun);
  const kept = beforeRuns.filter((run) => !isSimulationRun(run));
  const removedRunIds = new Set(removed.map((run) => run.sync_run_id));
  const cleaned = {
    ...store,
    runs: kept,
    status_events: (store.status_events ?? []).filter((event) => !removedRunIds.has(event.sync_run_id)),
    heartbeats: (store.heartbeats ?? []).filter((heartbeat) => heartbeat.source_system !== simSourceSystem && heartbeat.bridge_hostname !== "counterpoint-simulator"),
  };
  if (!dryRun) atomicWriteJson(jsonStorePath, cleaned);
  return {
    ok: true,
    store_type: "legacy_json",
    dry_run: dryRun,
    store_path: jsonStorePath,
    backup_path: dryRun ? null : `${jsonStorePath}.bak`,
    removed_runs: removed.length,
    removed_run_ids: Array.from(removedRunIds),
    remaining_runs: kept.length,
  };
}

try {
  const result = fs.existsSync(sqliteStorePath) ? clearSqlite() : clearLegacyJson();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[clear-simulation-data] ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
