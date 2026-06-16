#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, ".env"));

const HOST = process.env.COUNTERPOINT_SYNC_WORKBENCH_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.COUNTERPOINT_SYNC_WORKBENCH_PORT ?? "3015", 10);
const TOKEN = process.env.COUNTERPOINT_SYNC_WORKBENCH_TOKEN ?? "";
const JSON_STORE_PATH = path.resolve(
  __dirname,
  process.env.COUNTERPOINT_SYNC_WORKBENCH_STORE ?? "./data/sync-workbench-store.json",
);
const STORE_PATH = path.resolve(
  __dirname,
  process.env.COUNTERPOINT_SYNC_WORKBENCH_DB ??
    (JSON_STORE_PATH.endsWith(".json")
      ? JSON_STORE_PATH.replace(/\.json$/u, ".sqlite")
      : `${JSON_STORE_PATH}.sqlite`),
);
const SCHEMA_VERSION = 1;
let writeRouteLock = Promise.resolve();
let lastStoreRecovery = null;
let migrationStatus = { status: "not_started", message: "SQLite store not opened yet." };
let dbHandle = null;
const SECTION_LABELS = {
  customers: "Customers",
  catalog: "Products & Variants",
  inventory: "Inventory Counts",
  vendors: "Vendors",
  vendor_items: "Vendor Items",
  gift_cards: "Gift Cards",
  tickets: "Historical Sales/Tickets",
  store_credit_opening: "Store Credits",
  open_docs: "Open Docs",
  customer_notes: "Customer Notes",
  loyalty_hist: "Loyalty History",
  staff: "Staff/Sales Reps",
  receiving_history: "Receiving History",
  category_masters: "Category Masters",
  sales_rep_stubs: "Sales Rep Stubs",
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim();
  }
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function emptyStore() {
  return {
    schema_version: SCHEMA_VERSION,
    runs: [],
    ai_review_packages: [],
    ai_suggestions: [],
    review_decisions: [],
    heartbeats: [],
    status_events: [],
  };
}

function assertStoreShape(store, sourcePath) {
  if (!store || typeof store !== "object" || !Array.isArray(store.runs)) {
    throw new Error(`${sourcePath} is not a Counterpoint SYNC Workbench store.`);
  }
  if (!Array.isArray(store.heartbeats)) store.heartbeats = [];
  if (!Array.isArray(store.status_events)) store.status_events = [];
  if (!Array.isArray(store.ai_review_packages)) store.ai_review_packages = [];
  if (!Array.isArray(store.ai_suggestions)) store.ai_suggestions = [];
  if (!Array.isArray(store.review_decisions)) store.review_decisions = [];
  if (!store.schema_version) store.schema_version = SCHEMA_VERSION;
  return store;
}

function readJsonStoreFile(filePath) {
  return assertStoreShape(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath);
}

function loadJsonStoreForMigration() {
  if (!fs.existsSync(JSON_STORE_PATH)) return null;
  try {
    return readJsonStoreFile(JSON_STORE_PATH);
  } catch (error) {
    const backupPath = `${JSON_STORE_PATH}.bak`;
    if (!fs.existsSync(backupPath)) {
      throw new Error(
        `Counterpoint SYNC JSON store is corrupt and no backup exists at ${backupPath}: ${error?.message ?? String(error)}`,
      );
    }
    try {
      const backup = readJsonStoreFile(backupPath);
      lastStoreRecovery = {
        recovered_from: backupPath,
        failed_store: JSON_STORE_PATH,
        error: error?.message ?? String(error),
        recovered_at: nowIso(),
      };
      return backup;
    } catch (backupError) {
      throw new Error(
        `Counterpoint SYNC JSON store and backup are corrupt. Main error: ${error?.message ?? String(error)}. Backup error: ${backupError?.message ?? String(backupError)}`,
      );
    }
  }
}

function openStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  if (dbHandle) return dbHandle;
  const existed = fs.existsSync(STORE_PATH);
  dbHandle = new DatabaseSync(STORE_PATH);
  dbHandle.exec("PRAGMA journal_mode = WAL");
  dbHandle.exec("PRAGMA foreign_keys = ON");
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_runs (
      sync_run_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finalized_at TEXT,
      source TEXT,
      summary_json TEXT NOT NULL,
      run_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_run_sections (
      sync_run_id TEXT NOT NULL,
      section TEXT NOT NULL,
      entity TEXT NOT NULL,
      status TEXT NOT NULL,
      source_rows INTEGER NOT NULL DEFAULT 0,
      prepared_rows INTEGER NOT NULL DEFAULT 0,
      warnings INTEGER NOT NULL DEFAULT 0,
      blockers INTEGER NOT NULL DEFAULT 0,
      imported_status TEXT NOT NULL DEFAULT 'not_imported',
      ros_import_run_id TEXT,
      imported_package_fingerprint TEXT,
      imported_at TEXT,
      updated_at TEXT NOT NULL,
      section_json TEXT NOT NULL,
      PRIMARY KEY (sync_run_id, section)
    );
    CREATE TABLE IF NOT EXISTS sync_source_batches (
      source_batch_id TEXT NOT NULL,
      sync_run_id TEXT NOT NULL,
      section TEXT NOT NULL,
      entity TEXT NOT NULL,
      source_system TEXT NOT NULL,
      bridge_hostname TEXT,
      bridge_version TEXT,
      received_at TEXT NOT NULL,
      payload_fingerprint TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (sync_run_id, section, source_batch_id)
    );
    CREATE TABLE IF NOT EXISTS sync_packages (
      sync_run_id TEXT NOT NULL,
      section TEXT NOT NULL,
      entity TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      package_fingerprint TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      source_counts_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      exceptions_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'prepared',
      package_json TEXT NOT NULL,
      PRIMARY KEY (sync_run_id, section)
    );
    CREATE TABLE IF NOT EXISTS sync_exceptions (
      exception_id TEXT PRIMARY KEY,
      sync_run_id TEXT NOT NULL,
      section TEXT NOT NULL,
      severity TEXT NOT NULL,
      code TEXT,
      message TEXT NOT NULL,
      source_record_id TEXT,
      original_value TEXT,
      recommended_action TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      exception_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_provenance (
      provenance_id TEXT PRIMARY KEY,
      sync_run_id TEXT NOT NULL,
      section TEXT NOT NULL,
      source_system TEXT,
      source_batch_id TEXT,
      source_record_id TEXT,
      original_payload_json TEXT NOT NULL,
      normalized_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      provenance_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_ai_review_packages (
      review_package_id TEXT PRIMARY KEY,
      sync_run_id TEXT NOT NULL,
      section TEXT NOT NULL,
      package_fingerprint TEXT NOT NULL,
      review_type TEXT NOT NULL,
      status TEXT NOT NULL,
      exported_at TEXT NOT NULL,
      imported_at TEXT,
      summary_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_ai_suggestions (
      suggestion_id TEXT PRIMARY KEY,
      review_package_id TEXT NOT NULL,
      sync_run_id TEXT NOT NULL,
      section TEXT NOT NULL,
      suggestion_type TEXT NOT NULL,
      source_record_id TEXT,
      target_path TEXT NOT NULL,
      current_value_json TEXT NOT NULL,
      suggested_value_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT,
      suggestion_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_review_decisions (
      decision_id TEXT PRIMARY KEY,
      suggestion_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      edited_value_json TEXT,
      reviewer_note TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      decision_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_status_events (
      event_id TEXT PRIMARY KEY,
      sync_run_id TEXT,
      event_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_bridge_heartbeats (
      heartbeat_id TEXT PRIMARY KEY,
      bridge_hostname TEXT,
      bridge_version TEXT,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  dbHandle.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
  if (!existed) {
    const jsonStore = loadJsonStoreForMigration();
    if (jsonStore) {
      migrationStatus = {
        status: "migrated_from_json",
        message: "Existing JSON Workbench store was imported into SQLite. The JSON file was preserved.",
        json_store_path: JSON_STORE_PATH,
        migrated_at: nowIso(),
      };
      saveStore(jsonStore);
    } else {
      migrationStatus = { status: "fresh_sqlite", message: "SQLite Workbench store initialized.", migrated_at: nowIso() };
    }
  } else {
    migrationStatus = { status: "sqlite_ready", message: "SQLite Workbench store opened.", migrated_at: null };
  }
  return dbHandle;
}

function dbJson(value) {
  return JSON.stringify(value ?? null);
}

function parseDbJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadStore() {
  const db = openStore();
  const rows = db.prepare("SELECT run_json FROM sync_runs ORDER BY created_at DESC").all();
  const store = {
    schema_version: Number(db.prepare("SELECT value FROM sync_meta WHERE key = 'schema_version'").get()?.value ?? SCHEMA_VERSION),
    runs: rows.map((row) => parseDbJson(row.run_json, null)).filter(Boolean),
    ai_review_packages: db.prepare("SELECT payload_json FROM sync_ai_review_packages ORDER BY exported_at DESC").all().map((row) => parseDbJson(row.payload_json, null)).filter(Boolean),
    ai_suggestions: db.prepare("SELECT suggestion_json FROM sync_ai_suggestions ORDER BY created_at DESC").all().map((row) => parseDbJson(row.suggestion_json, null)).filter(Boolean),
    review_decisions: db.prepare("SELECT decision_json FROM sync_review_decisions ORDER BY created_at DESC").all().map((row) => parseDbJson(row.decision_json, null)).filter(Boolean),
    heartbeats: db.prepare("SELECT payload_json FROM sync_bridge_heartbeats ORDER BY received_at DESC LIMIT 100").all().map((row) => parseDbJson(row.payload_json, null)).filter(Boolean),
    status_events: db.prepare("SELECT event_json FROM sync_status_events ORDER BY created_at DESC LIMIT 500").all().map((row) => parseDbJson(row.event_json, null)).filter(Boolean),
  };
  return assertStoreShape(store, STORE_PATH);
}

function backupSqliteStore() {
  if (fs.existsSync(STORE_PATH)) {
    fs.copyFileSync(STORE_PATH, `${STORE_PATH}.bak`);
  }
}

function saveStore(store) {
  const db = openStore();
  store.schema_version = store.schema_version ?? SCHEMA_VERSION;
  backupSqliteStore();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "sync_runs",
      "sync_run_sections",
      "sync_source_batches",
      "sync_packages",
      "sync_exceptions",
      "sync_provenance",
      "sync_ai_review_packages",
      "sync_ai_suggestions",
      "sync_review_decisions",
      "sync_status_events",
      "sync_bridge_heartbeats",
    ]) {
      db.exec(`DELETE FROM ${table}`);
    }

    const insertRun = db.prepare("INSERT INTO sync_runs (sync_run_id, name, status, created_at, updated_at, finalized_at, source, summary_json, run_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertSection = db.prepare("INSERT INTO sync_run_sections (sync_run_id, section, entity, status, source_rows, prepared_rows, warnings, blockers, imported_status, ros_import_run_id, imported_package_fingerprint, imported_at, updated_at, section_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertBatch = db.prepare("INSERT INTO sync_source_batches (source_batch_id, sync_run_id, section, entity, source_system, bridge_hostname, bridge_version, received_at, payload_fingerprint, row_count, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertPackage = db.prepare("INSERT INTO sync_packages (sync_run_id, section, entity, schema_version, package_fingerprint, generated_at, source_counts_json, payload_json, exceptions_json, provenance_json, status, package_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertException = db.prepare("INSERT INTO sync_exceptions (exception_id, sync_run_id, section, severity, code, message, source_record_id, original_value, recommended_action, status, created_at, resolved_at, exception_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertProvenance = db.prepare("INSERT INTO sync_provenance (provenance_id, sync_run_id, section, source_system, source_batch_id, source_record_id, original_payload_json, normalized_payload_json, created_at, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertReviewPackage = db.prepare("INSERT INTO sync_ai_review_packages (review_package_id, sync_run_id, section, package_fingerprint, review_type, status, exported_at, imported_at, summary_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertSuggestion = db.prepare("INSERT INTO sync_ai_suggestions (suggestion_id, review_package_id, sync_run_id, section, suggestion_type, source_record_id, target_path, current_value_json, suggested_value_json, reason, confidence, risk_level, status, created_at, reviewed_at, reviewed_by, suggestion_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertDecision = db.prepare("INSERT INTO sync_review_decisions (decision_id, suggestion_id, decision, edited_value_json, reviewer_note, created_at, created_by, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEvent = db.prepare("INSERT INTO sync_status_events (event_id, sync_run_id, event_kind, created_at, event_json) VALUES (?, ?, ?, ?, ?)");
    const insertHeartbeat = db.prepare("INSERT INTO sync_bridge_heartbeats (heartbeat_id, bridge_hostname, bridge_version, received_at, payload_json) VALUES (?, ?, ?, ?, ?)");

    for (const run of store.runs) {
      const sections = Object.values(run.sections ?? {});
      insertRun.run(run.sync_run_id, run.name, run.status, run.created_at, run.updated_at, run.finalized_at ?? null, run.source ?? null, dbJson(publicRun(run)), dbJson(run));
      for (const section of sections) {
        insertSection.run(run.sync_run_id, section.section, section.section, section.status, section.source_count ?? 0, section.prepared_count ?? 0, section.warnings ?? 0, section.blockers ?? 0, section.status === "imported" ? "imported" : "not_imported", section.ros_import_run_id ?? null, section.imported_package_fingerprint ?? null, section.imported_at ?? null, section.updated_at ?? run.updated_at, dbJson(section));
      }
      for (const batch of run.source_batches ?? []) {
        insertBatch.run(batch.source_batch_id, run.sync_run_id, batch.section, batch.entity ?? batch.section, batch.source_system, batch.bridge_hostname ?? null, batch.bridge_version ?? null, batch.created_at ?? nowIso(), fingerprint(batch.payload ?? {}), batch.row_count ?? rowCount(batch.payload), dbJson(batch));
      }
      for (const pkg of Object.values(run.packages ?? {})) {
        insertPackage.run(run.sync_run_id, pkg.section, pkg.entity, pkg.schema_version, pkg.package_fingerprint, pkg.generated_at, dbJson(pkg.source_counts), dbJson(pkg.payload), dbJson(pkg.exceptions), dbJson(pkg.provenance), "prepared", dbJson(pkg));
      }
      for (const exception of run.exceptions ?? []) {
        insertException.run(exception.id, run.sync_run_id, exception.section, exception.severity, exception.code ?? null, exception.message, exception.source_record_id ?? null, exception.original_value == null ? null : String(exception.original_value), exception.recommended_action ?? null, exception.status ?? "open", exception.created_at ?? nowIso(), exception.resolved_at ?? null, dbJson(exception));
      }
      for (const provenance of run.provenance ?? []) {
        insertProvenance.run(provenance.id, run.sync_run_id, provenance.section, provenance.source_system ?? null, provenance.source_batch_id ?? null, provenance.source_record_id ?? null, dbJson(provenance.original_payload), dbJson(provenance.normalized_payload), provenance.created_at ?? nowIso(), dbJson(provenance));
      }
    }
    for (const reviewPackage of store.ai_review_packages ?? []) {
      insertReviewPackage.run(reviewPackage.review_package_id, reviewPackage.sync_run_id, reviewPackage.section, reviewPackage.package_fingerprint, reviewPackage.review_type, reviewPackage.status, reviewPackage.exported_at, reviewPackage.imported_at ?? null, dbJson(reviewPackage.summary ?? {}), dbJson(reviewPackage));
    }
    for (const suggestion of store.ai_suggestions ?? []) {
      insertSuggestion.run(suggestion.suggestion_id, suggestion.review_package_id, suggestion.sync_run_id, suggestion.section, suggestion.suggestion_type, suggestion.source_record_id ?? null, suggestion.target_path, dbJson(suggestion.current_value), dbJson(suggestion.suggested_value), suggestion.reason, suggestion.confidence, suggestion.risk_level, suggestion.status, suggestion.created_at, suggestion.reviewed_at ?? null, suggestion.reviewed_by ?? null, dbJson(suggestion));
    }
    for (const decision of store.review_decisions ?? []) {
      insertDecision.run(decision.decision_id, decision.suggestion_id, decision.decision, dbJson(decision.edited_value ?? null), decision.reviewer_note ?? null, decision.created_at, decision.created_by ?? null, dbJson(decision));
    }
    for (const event of store.status_events ?? []) {
      insertEvent.run(event.id, event.sync_run_id ?? null, event.event_kind, event.created_at, dbJson(event));
    }
    for (const heartbeat of store.heartbeats ?? []) {
      insertHeartbeat.run(heartbeat.id ?? newId("heartbeat"), heartbeat.bridge_hostname ?? null, heartbeat.bridge_version ?? null, heartbeat.received_at ?? nowIso(), dbJson(heartbeat));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function withStoreMutation(mutator) {
  const store = loadStore();
  const result = await mutator(store);
  saveStore(store);
  return result;
}

function storeFileInfo(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, size_bytes: 0, modified_at: null };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    size_bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
  };
}

function storeHealth() {
  const main = storeFileInfo(STORE_PATH);
  const backup = storeFileInfo(`${STORE_PATH}.bak`);
  let format_version = SCHEMA_VERSION;
  let readable = true;
  let error = null;
  try {
    format_version = loadStore().schema_version ?? SCHEMA_VERSION;
  } catch (loadError) {
    readable = false;
    error = loadError?.message ?? String(loadError);
  }
  return {
    type: "sqlite",
    path: STORE_PATH,
    json_migration_source_path: JSON_STORE_PATH,
    exists: main.exists,
    backup_exists: backup.exists,
    last_write_at: main.modified_at,
    size_bytes: main.size_bytes,
    backup_size_bytes: backup.size_bytes,
    format_version,
    readable,
    error,
    last_recovery: lastStoreRecovery,
    migration_status: migrationStatus,
  };
}

function exportStore() {
  return {
    schema_version: SCHEMA_VERSION,
    exported_at: nowIso(),
    store_type: "sqlite",
    store_path: STORE_PATH,
    json_migration_source_path: JSON_STORE_PATH,
    migration_status: migrationStatus,
    store: loadStore(),
  };
}

function activeRun(store, requestedRunId) {
  if (requestedRunId) {
    const existing = store.runs.find((run) => run.sync_run_id === requestedRunId);
    if (existing) return existing;
    const created = nowIso();
    const run = {
      sync_run_id: requestedRunId,
      name: `Counterpoint transition ${created.slice(0, 10)}`,
      status: "raw",
      created_at: created,
      updated_at: created,
      sections: {},
      source_batches: [],
      exceptions: [],
      provenance: [],
      packages: {},
    };
    store.runs.unshift(run);
    return run;
  }
  const open = store.runs.find((run) => !["imported_to_ros", "archived"].includes(run.status));
  if (open) return open;
  const created = nowIso();
  const run = {
    sync_run_id: requestedRunId || crypto.randomUUID(),
    name: `Counterpoint transition ${created.slice(0, 10)}`,
    status: "raw",
    created_at: created,
    updated_at: created,
    sections: {},
    source_batches: [],
    exceptions: [],
    provenance: [],
    packages: {},
  };
  store.runs.unshift(run);
  return run;
}

function sectionFor(run, section) {
  const key = normalizeSection(section);
  if (!run.sections[key]) {
    const ts = nowIso();
    run.sections[key] = {
      section: key,
      label: SECTION_LABELS[key] ?? key,
      status: "not_started",
      source_count: 0,
      prepared_count: 0,
      warnings: 0,
      blockers: 0,
      review_status: "raw",
      package_fingerprint: null,
      created_at: ts,
      updated_at: ts,
      approved_at: null,
      approved_by: null,
    };
  }
  return run.sections[key];
}

function normalizeSection(section) {
  return String(section ?? "").trim().replace(/-/g, "_").toLowerCase();
}

function rowCount(payload) {
  if (Array.isArray(payload?.rows)) return payload.rows.length;
  if (Array.isArray(payload?.codes)) return payload.codes.length;
  if (Array.isArray(payload)) return payload.length;
  return payload == null ? 0 : 1;
}

function publicHeartbeat(store) {
  return store.heartbeats[0] ?? null;
}

function appendExceptions(run, section, sourceBatchId, exceptions = []) {
  for (const item of exceptions) {
    const severity = String(item.severity ?? "warning").toLowerCase() === "blocker" ? "blocker" : "warning";
    run.exceptions.push({
      id: item.id ?? newId("exc"),
      section,
      severity,
      code: item.code ?? (severity === "blocker" ? "blocked_record" : "review_warning"),
      status: item.status ?? "open",
      message: item.message ?? "Record requires SYNC review.",
      source_batch_id: sourceBatchId,
      source_record_id: item.source_record_id ?? null,
      original_value: item.original_value ?? null,
      recommended_action: item.recommended_action ?? "Review in Counterpoint SYNC before ROS import.",
      source_payload: item.source_payload ?? {},
      created_at: item.created_at ?? nowIso(),
    });
  }
}

function summarizeRuns(store) {
  const runs = store.runs.map(publicRun);
  const sections = store.runs.flatMap((run) => Object.values(run.sections));
  return {
    runs_count: runs.length,
    ready_sections: sections.filter((section) => ["ready", "ready_with_warnings"].includes(section.status)).length,
    imported_sections: sections.filter((section) => section.status === "imported").length,
    blocked_sections: sections.filter((section) => section.status === "blocked" || section.blockers > 0).length,
    warnings: sections.reduce((sum, section) => sum + section.warnings, 0),
    blockers: sections.reduce((sum, section) => sum + section.blockers, 0),
  };
}

const REVIEW_TYPES = new Set([
  "inventory_cleanup",
  "customer_dedupe",
  "product_readability",
  "category_vendor_mapping",
  "exception_triage",
  "full_section_review",
]);
const SUGGESTION_TYPES = new Set([
  "phone_normalization",
  "duplicate_email_handling",
  "customer_duplicate_cluster",
  "name_casing_cleanup",
  "product_name_cleanup",
  "description_readability",
  "category_suggestion",
  "vendor_suggestion",
  "attribute_normalization",
  "inventory_catalog_mismatch_explanation",
  "location_cleanup",
  "vendor_name_cleanup",
  "vendor_duplicate_candidate",
  "missing_optional_info_warning",
  "high_risk_manual_review",
  "exception_triage",
]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);
const HIGH_RISK_SECTIONS = new Set(["gift_cards", "store_credit_opening", "tickets", "open_docs", "loyalty_hist"]);
const SECTION_ALLOWED_FIELDS = {
  customers: new Set(["phone", "email", "first_name", "last_name", "name", "full_name"]),
  catalog: new Set(["description", "name", "product_category", "category", "vendor_code", "vendor_name", "brand_name"]),
  inventory: new Set(["location", "bin", "bin_location"]),
  vendors: new Set(["name", "vendor_name", "phone", "email"]),
};

function reviewPackageInstructions(section) {
  return [
    "This is a Counterpoint SYNC review package for Riverside OS.",
    "Return only valid suggestion JSON matching allowed_suggestion_schema.",
    "This is review-only. Do not claim that changes have been applied.",
    "Preserve sync_run_id, review_package_id, package_fingerprint, section, and source_record_id.",
    "Do not invent costs, quantities, balances, emails, tax values, tender values, payment values, refund values, or accounting mappings.",
    "Do not merge customers or vendors automatically.",
    "For gift cards, store credit, historical tickets, open docs, loyalty history, tax, payment, and balance fields, provide manual-review suggestions only.",
    `Section under review: ${section}.`,
  ];
}

function allowedSuggestionSchema() {
  return {
    review_package_id: "string",
    sync_run_id: "string",
    section: "string",
    package_fingerprint: "string",
    suggestions: [{
      suggestion_type: Array.from(SUGGESTION_TYPES).sort(),
      source_record_id: "string|null",
      target_path: "payload.rows[0].field",
      current_value: "any JSON value",
      suggested_value: "any JSON value",
      reason: "string",
      confidence: ["low", "medium", "high"],
      risk_level: ["low", "medium", "high"],
    }],
  };
}

function packageRows(pkg) {
  return Array.isArray(pkg?.payload?.rows) ? pkg.payload.rows : [];
}

function createAiReviewPackage(store, run, section, reviewType = "full_section_review", mode = "warnings_blockers") {
  const key = normalizeSection(section);
  if (!REVIEW_TYPES.has(reviewType)) {
    throw new Error(`Unsupported AI review type: ${reviewType}`);
  }
  const pkg = packageFor(run, key);
  const exceptions = pkg.exceptions ?? [];
  const rows = packageRows(pkg);
  const exceptionRecordIds = new Set(exceptions.map((item) => item.source_record_id).filter(Boolean));
  const reviewRows = mode === "sample"
    ? rows.slice(0, 50)
    : mode === "warnings_blockers"
      ? rows.filter((row) => exceptionRecordIds.size === 0 || exceptionRecordIds.has(row.source_record_id ?? row.cust_no ?? row.item_no ?? row.vendor_code ?? row.sku)).slice(0, 500)
      : rows;
  const reviewPackage = {
    review_package_id: crypto.randomUUID(),
    sync_run_id: run.sync_run_id,
    section: key,
    entity: pkg.entity,
    package_fingerprint: pkg.package_fingerprint,
    review_type: reviewType,
    status: "exported",
    exported_at: nowIso(),
    imported_at: null,
    instructions: reviewPackageInstructions(key),
    source_counts: pkg.source_counts,
    warnings: pkg.source_counts.warnings,
    blockers: pkg.source_counts.blockers,
    sample_or_full_records: reviewRows,
    records_mode: mode,
    total_payload_rows: rows.length,
    exceptions,
    provenance: pkg.provenance,
    allowed_suggestion_schema: allowedSuggestionSchema(),
    do_not_rules: [
      "Do not directly write to ROS PostgreSQL.",
      "Do not directly import into ROS.",
      "Do not silently mutate package data.",
      "Do not auto-accept suggestions.",
      "Do not invent financial, accounting, tax, payment, quantity, balance, or cost values.",
      "Do not auto-merge customers or vendors.",
    ],
    summary: {
      section: key,
      raw: pkg.source_counts.raw,
      prepared: pkg.source_counts.prepared,
      warnings: pkg.source_counts.warnings,
      blockers: pkg.source_counts.blockers,
      package_fingerprint: pkg.package_fingerprint,
    },
  };
  store.ai_review_packages.unshift(reviewPackage);
  statusEvent(store, run, "ai_review_package_exported", {
    section: key,
    review_package_id: reviewPackage.review_package_id,
    package_fingerprint: pkg.package_fingerprint,
  });
  return reviewPackage;
}

function findReviewPackage(store, reviewPackageId) {
  return store.ai_review_packages.find((item) => item.review_package_id === reviewPackageId) ?? null;
}

function allowedTargetPath(section, targetPath) {
  const key = normalizeSection(section);
  const match = String(targetPath ?? "").match(/^payload\.rows\[(\d+)\]\.([A-Za-z0-9_]+)$/u);
  if (!match) return false;
  if (HIGH_RISK_SECTIONS.has(key)) return false;
  const allowedFields = SECTION_ALLOWED_FIELDS[key];
  return allowedFields ? allowedFields.has(match[2]) : false;
}

function validateSuggestion(reviewPackage, item) {
  const errors = [];
  if (!SUGGESTION_TYPES.has(item.suggestion_type)) errors.push("unsupported suggestion_type");
  if (!allowedTargetPath(reviewPackage.section, item.target_path)) errors.push("target_path is not allowed for this section");
  if (!RISK_LEVELS.has(item.risk_level)) errors.push("unsupported risk_level");
  if (!CONFIDENCE_LEVELS.has(item.confidence)) errors.push("unsupported confidence");
  if (item.reason == null || String(item.reason).trim() === "") errors.push("reason is required");
  if (HIGH_RISK_SECTIONS.has(reviewPackage.section) && item.risk_level !== "high") {
    errors.push("high-risk sections require high risk manual-review suggestions");
  }
  return errors;
}

function importAiSuggestions(store, body) {
  const reviewPackage = findReviewPackage(store, body.review_package_id);
  if (!reviewPackage) throw new Error("AI review package not found.");
  if (body.sync_run_id !== reviewPackage.sync_run_id) throw new Error("AI suggestion sync_run_id does not match review package.");
  if (normalizeSection(body.section) !== reviewPackage.section) throw new Error("AI suggestion section does not match review package.");
  if (body.package_fingerprint !== reviewPackage.package_fingerprint) throw new Error("AI suggestion package_fingerprint does not match review package.");
  const suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
  const result = { imported: 0, rejected: 0, duplicate: 0, high_risk: 0, invalid: 0, errors: [] };
  const duplicateKeys = new Set(store.ai_suggestions.map((item) => `${item.review_package_id}:${item.target_path}:${item.source_record_id ?? ""}:${stableStringify(item.suggested_value)}`));
  for (const item of suggestions) {
    const normalized = {
      suggestion_id: item.suggestion_id ?? crypto.randomUUID(),
      review_package_id: reviewPackage.review_package_id,
      sync_run_id: reviewPackage.sync_run_id,
      section: reviewPackage.section,
      suggestion_type: item.suggestion_type,
      source_record_id: item.source_record_id ?? null,
      target_path: item.target_path,
      current_value: item.current_value ?? null,
      suggested_value: item.suggested_value ?? null,
      reason: item.reason,
      confidence: item.confidence,
      risk_level: item.risk_level,
      status: "pending",
      created_at: nowIso(),
      reviewed_at: null,
      reviewed_by: null,
    };
    const errors = validateSuggestion(reviewPackage, normalized);
    const duplicateKey = `${normalized.review_package_id}:${normalized.target_path}:${normalized.source_record_id ?? ""}:${stableStringify(normalized.suggested_value)}`;
    if (duplicateKeys.has(duplicateKey)) {
      result.duplicate += 1;
      continue;
    }
    if (errors.length > 0) {
      result.rejected += 1;
      result.invalid += 1;
      result.errors.push({ source_record_id: normalized.source_record_id, target_path: normalized.target_path, errors });
      continue;
    }
    if (normalized.risk_level === "high") result.high_risk += 1;
    duplicateKeys.add(duplicateKey);
    store.ai_suggestions.unshift(normalized);
    result.imported += 1;
  }
  reviewPackage.status = "suggestions_imported";
  reviewPackage.imported_at = nowIso();
  return result;
}

function setValueAtPayloadPath(payload, targetPath, value) {
  const match = String(targetPath ?? "").match(/^payload\.rows\[(\d+)\]\.([A-Za-z0-9_]+)$/u);
  if (!match || !Array.isArray(payload.rows)) return false;
  const row = payload.rows[Number.parseInt(match[1], 10)];
  if (!row || typeof row !== "object") return false;
  row[match[2]] = value;
  return true;
}

function applyAcceptedSuggestions(store, runId, section) {
  const run = store.runs.find((item) => item.sync_run_id === runId);
  if (!run) throw new Error("SYNC run not found.");
  const key = normalizeSection(section);
  if (HIGH_RISK_SECTIONS.has(key)) {
    return { applied: 0, skipped: store.ai_suggestions.filter((item) => item.sync_run_id === runId && item.section === key && item.status === "accepted").length, package_fingerprint: run.sections[key]?.package_fingerprint ?? null };
  }
  const accepted = store.ai_suggestions.filter((item) => item.sync_run_id === runId && item.section === key && item.status === "accepted");
  let applied = 0;
  for (const suggestion of accepted) {
    for (const batch of run.source_batches.filter((item) => item.section === key)) {
      const payload = batch.payload ?? {};
      if (setValueAtPayloadPath(payload, suggestion.target_path, suggestion.accepted_value ?? suggestion.suggested_value)) {
        batch.normalized_payload = payload;
        suggestion.status = "applied";
        suggestion.applied_at = nowIso();
        applied += 1;
        break;
      }
    }
  }
  const pkg = packageFor(run, key);
  const sectionState = sectionFor(run, key);
  sectionState.status = sectionState.blockers > 0 ? "blocked" : "in_review";
  sectionState.ros_preflight_status = "stale_package_changed";
  run.updated_at = nowIso();
  statusEvent(store, run, "accepted_ai_suggestions_applied", {
    section: key,
    applied,
    package_fingerprint: pkg.package_fingerprint,
  });
  return { applied, skipped: accepted.length - applied, package_fingerprint: pkg.package_fingerprint };
}

function packageFor(run, section) {
  const key = normalizeSection(section);
  const batches = run.source_batches.filter((batch) => batch.section === key);
  const rows = [];
  for (const batch of batches) {
    if (Array.isArray(batch.payload?.rows)) rows.push(...batch.payload.rows);
    else if (Array.isArray(batch.payload?.codes)) rows.push(...batch.payload.codes);
    else if (Array.isArray(batch.payload)) rows.push(...batch.payload);
  }
  const payload = batches.length === 1 && batches[0].payload?.rows
    ? batches[0].payload
    : { rows };
  const exceptions = run.exceptions.filter((item) => item.section === key);
  const provenance = run.provenance.filter((item) => item.section === key);
  const source_counts = {
    raw: batches.reduce((sum, batch) => sum + batch.row_count, 0),
    prepared: rowCount(payload),
    warnings: exceptions.filter((item) => item.severity === "warning").length,
    blockers: exceptions.filter((item) => item.severity === "blocker").length,
  };
  const fingerprintExceptions = exceptions.map((item) => ({
    section: item.section,
    severity: item.severity,
    code: item.code ?? null,
    status: item.status ?? null,
    message: item.message ?? null,
    source_record_id: item.source_record_id ?? null,
    original_value: item.original_value ?? null,
    recommended_action: item.recommended_action ?? null,
    source_payload: item.source_payload ?? null,
  }));
  const fingerprintProvenance = provenance.map((item) => ({
    section: item.section,
    source_system: item.source_system,
    source_batch_id: item.source_batch_id,
    source_record_id: item.source_record_id,
    original_payload: item.original_payload,
    normalized_payload: item.normalized_payload,
  }));
  const packageContract = {
    sync_run_id: run.sync_run_id,
    section: key,
    entity: key,
    schema_version: SCHEMA_VERSION,
    source_counts,
    payload,
    exceptions,
    provenance,
  };
  const stablePackageContent = {
    section: key,
    entity: key,
    schema_version: SCHEMA_VERSION,
    source_counts,
    payload,
    exceptions: fingerprintExceptions,
    provenance: fingerprintProvenance,
  };
  const package_fingerprint = fingerprint(stablePackageContent);
  const existing = run.packages[key];
  const generated_at = existing?.package_fingerprint === package_fingerprint
    ? existing.generated_at
    : nowIso();
  const packagePayload = {
    ...packageContract,
    generated_at,
    package_fingerprint,
  };
  run.packages[key] = packagePayload;
  const sectionState = sectionFor(run, key);
  sectionState.source_count = source_counts.raw;
  sectionState.prepared_count = source_counts.prepared;
  sectionState.warnings = source_counts.warnings;
  sectionState.blockers = source_counts.blockers;
  sectionState.package_fingerprint = packagePayload.package_fingerprint;
  sectionState.updated_at = nowIso();
  if (source_counts.blockers > 0 && sectionState.status !== "imported") {
    sectionState.status = "blocked";
  } else if (sectionState.status === "not_started") {
    sectionState.status = "raw_received";
  }
  return packagePayload;
}

function publicRun(run) {
  const sections = Object.values(run.sections);
  return {
    sync_run_id: run.sync_run_id,
    name: run.name,
    status: run.status,
    created_at: run.created_at,
    updated_at: run.updated_at,
    sections_ready: sections.filter((section) => ["ready", "ready_with_warnings", "imported"].includes(section.status)).length,
    warnings: sections.reduce((sum, section) => sum + section.warnings, 0),
    blockers: sections.reduce((sum, section) => sum + section.blockers, 0),
    source_batches: run.source_batches.length,
    ai_pending_suggestions: 0,
    imported_status: sections.every((section) => section.status === "imported") && sections.length > 0 ? "imported" : "not_imported",
  };
}

function sectionAiSummary(store, runId, section) {
  const rows = store.ai_suggestions.filter((item) => item.sync_run_id === runId && item.section === section);
  return {
    ai_pending_suggestions: rows.filter((item) => item.status === "pending").length,
    ai_accepted_suggestions: rows.filter((item) => item.status === "accepted").length,
    ai_applied_suggestions: rows.filter((item) => item.status === "applied").length,
    ai_manual_review_suggestions: rows.filter((item) => item.status === "needs_manual_review").length,
  };
}

function publicRunDetail(store, run) {
  const sections = Object.values(run.sections).map((section) => ({
    ...section,
    ...sectionAiSummary(store, run.sync_run_id, section.section),
  }));
  return { ...publicRun(run), sections };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Counterpoint SYNC Workbench</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fb; color: #111827; }
    main { max-width: 1220px; margin: 0 auto; padding: 24px; }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 22px; letter-spacing: .02em; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .12em; color: #4b5563; }
    p { margin: 0; }
    button, input, select { font: inherit; }
    input, select { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; background: #fff; color: #111827; }
    button { border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #111827; padding: 8px 10px; cursor: pointer; font-weight: 700; }
    button:disabled { cursor: not-allowed; opacity: .5; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 18px; }
    .token { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .grid { display: grid; gap: 12px; }
    .stats { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
    .card { min-width: 0; border: 1px solid #e5e7eb; border-radius: 8px; background: rgba(255,255,255,.9); padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    .muted { color: #6b7280; font-size: 12px; }
    .value { margin-top: 4px; font-size: clamp(13px, 1.5vw, 18px); line-height: 1.2; font-weight: 900; overflow-wrap: anywhere; word-break: break-word; }
    .section { margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 9px 8px; text-align: left; vertical-align: top; }
    th { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
	    .pill { display: inline-flex; border-radius: 999px; padding: 3px 8px; font-size: 10px; font-weight: 900; background: #eef2ff; color: #3730a3; }
	    .ok { background: #dcfce7; color: #166534; }
	    .warn { background: #fef3c7; color: #92400e; }
	    .bad { background: #fee2e2; color: #991b1b; }
	    .primary { background: #2563eb; color: #fff; border-color: #2563eb; }
	    .danger { color: #991b1b; border-color: #fecaca; background: #fff7f7; }
	    .stepgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
	    .step { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; background: #fff; }
	    .step strong { display:block; font-size: 12px; }
	    .actions { display:flex; flex-wrap:wrap; gap:6px; }
	    .filegrid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:10px; }
	    .filebox { border: 1px dashed #cbd5e1; border-radius: 8px; padding: 10px; background: #f8fafc; }
	    .split { display: grid; grid-template-columns: minmax(260px,.35fr) minmax(0,1fr); gap: 12px; }
    pre { max-height: 340px; overflow: auto; white-space: pre-wrap; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #0f172a; color: #e5e7eb; font-size: 11px; }
    details { margin-top: 10px; }
    summary { cursor: pointer; font-weight: 800; font-size: 12px; }
    @media (max-width: 820px) { main { padding: 14px; } .split { grid-template-columns: 1fr; } }
    @media (prefers-color-scheme: dark) {
	      body { background: #0b1220; color: #e5e7eb; }
	      input, select, button, .card, .step, .filebox { background: #111827; color: #e5e7eb; border-color: #374151; }
	      th, td { border-color: #263244; }
	      h2, .muted { color: #9ca3af; }
	      .primary { background: #2563eb; color: #fff; border-color: #2563eb; }
	      .danger { color: #fecaca; border-color: #7f1d1d; background: #1f1111; }
	    }
  </style>
</head>
<body>
  <main>
    <div class="toolbar">
      <div>
        <h1>Counterpoint SYNC Workbench</h1>
        <p class="muted">Main Hub preparation, review, package generation, and ROS handoff. No data is written to ROS here.</p>
      </div>
      <div class="token">
        ${TOKEN.trim() ? `
        <input id="token" type="password" placeholder="SYNC token" autocomplete="off" />
        <button id="saveToken">Save Token</button>
        ` : ""}
        <button id="refresh">Refresh</button>
        <button id="export">Export Store</button>
      </div>
	    </div>
	    <section class="grid stats" id="stats"></section>
	    <section class="section card">
	      <h2>Preparation Pipeline</h2>
	      <div class="stepgrid" style="margin-top:10px">
	        <div class="step"><strong>1. Receive</strong><span class="muted">Bridge raw extraction batches land here.</span></div>
	        <div class="step"><strong>2. Add inventory CSV context</strong><span class="muted">One Lightspeed CSV and one Counterpoint CSV help clean product, SKU, item number, and variation data.</span></div>
	        <div class="step"><strong>3. Review and fix</strong><span class="muted">Warnings, blockers, duplicates, and AI suggestions stay in SYNC.</span></div>
	        <div class="step"><strong>4. Mark ready</strong><span class="muted">Approved sections become ROS-ready JSON packages.</span></div>
	        <div class="step"><strong>5. ROS imports</strong><span class="muted">ROS pulls selected packages and writes through its importer.</span></div>
	      </div>
	    </section>
	    <section class="section card">
	      <div class="toolbar" style="margin-bottom:8px">
	        <div>
	          <h2>Inventory CSV Inputs</h2>
	          <p class="muted">Only two CSV files belong here: the Lightspeed inventory export and the Counterpoint inventory export. They are cleanup/reference inputs for product names, SKUs, item numbers, categories, and variations. Inventory quantities come from Counterpoint SQL unless SQL has no usable value.</p>
	        </div>
	        <span class="pill">Inventory reference only</span>
	      </div>
	      <div class="filegrid">
	        <div class="filebox">
	          <strong>Lightspeed CSV</strong>
	          <p class="muted">Use the Lightspeed inventory export for product titles, categories, SKUs, item numbers, and variation cleanup.</p>
	          <input id="lightspeedCsv" type="file" accept=".csv,text/csv" style="margin-top:8px;width:100%;box-sizing:border-box" />
	        </div>
	        <div class="filebox">
	          <strong>Counterpoint CSV</strong>
	          <p class="muted">Use the Counterpoint inventory export as source proof and cleanup reference. Counterpoint SQL remains the primary quantity source.</p>
	          <input id="counterpointCsv" type="file" accept=".csv,text/csv" style="margin-top:8px;width:100%;box-sizing:border-box" />
	        </div>
	      </div>
	      <div id="csvStatus" class="muted" style="margin-top:8px">No CSV imported in this browser session.</div>
	    </section>
	    <section class="section split">
      <div class="card">
        <h2>Runs</h2>
        <div id="runs"></div>
      </div>
      <div class="card">
        <h2>Run Detail</h2>
        <div id="detail" class="muted">Select a run.</div>
      </div>
    </section>
    <section class="section card">
      <h2>Exceptions</h2>
      <div id="exceptions" class="muted">Select a run.</div>
    </section>
    <section class="section card">
      <h2>Package Preview</h2>
      <div id="packagePreview" class="muted">Preview a package from a run section.</div>
    </section>
    <section class="section card">
      <h2>AI Review</h2>
      <p class="muted">Review-first only. Export a package for Codex/ChatGPT, import suggestion JSON, then accept/reject suggestions before applying accepted low/medium-risk cleanup to prepared SYNC data. No records are changed automatically.</p>
      <div style="margin-top:10px;display:grid;gap:8px">
        <textarea id="suggestionImport" rows="8" placeholder="Paste AI suggestion JSON here" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:10px;background:inherit;color:inherit"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="importSuggestions">Import AI Suggestions</button>
          <button id="reloadSuggestions">View AI Suggestions</button>
        </div>
      </div>
      <div id="aiSuggestions" class="muted" style="margin-top:10px">No suggestions loaded.</div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("token");
    const savedToken = localStorage.getItem("counterpointSyncToken") || "";
    if (tokenInput) tokenInput.value = savedToken;
    let selectedRunId = "";
    const authHeaders = () => tokenInput?.value
      ? { "x-counterpoint-sync-token": tokenInput.value, "authorization": "Bearer " + tokenInput.value }
      : {};
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    }
    const fmt = (value) => value == null || value === "" ? "Not reported" : String(value);
    const pill = (value, bad = false, warn = false) => '<span class="pill ' + (bad ? "bad" : warn ? "warn" : "ok") + '">' + value + '</span>';
    function stat(label, value, detail = "") { return '<div class="card"><p class="muted">' + label + '</p><p class="value">' + value + '</p>' + (detail ? '<p class="muted" style="overflow-wrap:anywhere;margin-top:4px">' + detail + '</p>' : '') + '</div>'; }
    async function refresh() {
      const health = await fetch("/health").then((res) => res.json());
      const runs = await api("/api/runs");
      const summary = health.summary || {};
      document.getElementById("stats").innerHTML = [
        stat("Workbench status", health.ok ? "Online" : "Check"),
        stat("Store", health.store?.healthy === false ? "Check" : "Ready", health.store?.path || health.store_path || "Not reported"),
        stat("Backup", health.store?.backup_exists ? "Available" : "Missing"),
        stat("Bridge heartbeat", health.last_bridge_heartbeat ? "Received" : "None"),
        stat("Runs", summary.runs_count || runs.runs.length || 0),
        stat("Ready / Blocked", (summary.ready_sections || 0) + " / " + (summary.blocked_sections || 0)),
        stat("Warnings / Blockers", (summary.warnings || 0) + " / " + (summary.blockers || 0)),
        stat("Store size", (health.store?.size_bytes || 0) + " bytes"),
      ].join("");
      if (!selectedRunId && runs.runs[0]) selectedRunId = runs.runs[0].sync_run_id;
      document.getElementById("runs").innerHTML = runs.runs.length
        ? runs.runs.map((run) => '<button style="display:block;width:100%;text-align:left;margin-top:8px" data-run="' + run.sync_run_id + '">' +
          '<strong>' + run.name + '</strong><br><span class="muted">' + run.sync_run_id + '</span><br>' +
          pill(run.status, run.blockers > 0, run.warnings > 0) + ' <span class="muted">Sections ready ' + run.sections_ready + ', warnings ' + run.warnings + ', blockers ' + run.blockers + ', imported ' + run.imported_status + '</span></button>').join("")
        : '<p class="muted">No runs. Start the simulator or send Bridge batches.</p>';
      document.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => { selectedRunId = button.dataset.run || ""; loadRun(); }));
      await loadRun();
    }
    async function loadRun() {
      if (!selectedRunId) return;
      const data = await api("/api/runs/" + encodeURIComponent(selectedRunId));
      const sections = data.run.sections || [];
      document.getElementById("detail").innerHTML = '<p><strong>Selected SYNC Run:</strong> ' + data.run.name + '</p><p class="muted">' + data.run.sync_run_id + '</p>' +
        '<table><thead><tr><th>Section</th><th>Status</th><th>Rows</th><th>Warnings</th><th>Blockers</th><th>Imported</th><th>Fingerprint</th><th>Actions</th></tr></thead><tbody>' +
        sections.map((section) => '<tr><td><strong>' + section.label + '</strong></td><td>' + pill(section.status, section.blockers > 0 || section.status === "blocked", section.warnings > 0) + '</td>' +
          '<td>' + section.source_count + ' source / ' + section.prepared_count + ' prepared</td><td>' + section.warnings + '</td><td>' + section.blockers + '</td>' +
          '<td>' + fmt(section.imported_at) + '<br><span class="muted">' + fmt(section.ros_import_run_id) + '</span></td>' +
          '<td><code>' + fmt(section.package_fingerprint).slice(0, 16) + '</code></td>' +
	        '<td><div class="actions"><button data-package="' + section.section + '">Preview</button><button class="primary" data-ready="' + section.section + '">Mark ready</button><button class="danger" data-block="' + section.section + '">Block</button><button data-ai-export="' + section.section + '">AI pack</button><button data-ai-apply="' + section.section + '">Apply AI</button></div></td></tr>').join("") + '</tbody></table>';
	      document.querySelectorAll("[data-package]").forEach((button) => button.addEventListener("click", () => previewPackage(button.dataset.package || "")));
	      document.querySelectorAll("[data-ready]").forEach((button) => button.addEventListener("click", () => markSectionReady(button.dataset.ready || "")));
	      document.querySelectorAll("[data-block]").forEach((button) => button.addEventListener("click", () => markSectionBlocked(button.dataset.block || "")));
	      document.querySelectorAll("[data-ai-export]").forEach((button) => button.addEventListener("click", () => exportAiReviewPackage(button.dataset.aiExport || "")));
	      document.querySelectorAll("[data-ai-apply]").forEach((button) => button.addEventListener("click", () => applyAcceptedSuggestions(button.dataset.aiApply || "")));
      const exceptions = await api("/api/runs/" + encodeURIComponent(selectedRunId) + "/exceptions");
      document.getElementById("exceptions").innerHTML = renderExceptions(exceptions.exceptions || []);
      await loadSuggestions();
    }
    function renderExceptions(rows) {
      if (!rows.length) return '<p class="muted">No warnings or blockers for the selected run.</p>';
      const group = (name, predicate) => rows.filter(predicate).map((row) =>
        '<tr><td>' + pill(row.severity, row.severity === "blocker", row.severity === "warning") + '</td><td>' + row.section + '</td><td>' + fmt(row.code) + '</td><td>' + row.message + '</td><td>' + fmt(row.source_record_id) + '</td><td>' + fmt(row.original_value) + '</td><td>' + fmt(row.recommended_action) + '</td><td>' + fmt(row.status) + '</td></tr>').join("");
      return '<table><thead><tr><th>Severity</th><th>Section</th><th>Code</th><th>Message</th><th>Source record</th><th>Original value</th><th>Recommended action</th><th>Status</th></tr></thead><tbody>' +
        group("Blockers", (row) => row.severity === "blocker" && row.status !== "resolved") +
        group("Warnings", (row) => row.severity === "warning" && row.status !== "resolved") +
        group("Resolved", (row) => row.status === "resolved") + '</tbody></table>';
    }
	    async function previewPackage(section) {
      const pkg = await api("/api/runs/" + encodeURIComponent(selectedRunId) + "/packages/" + encodeURIComponent(section));
      const rowCount = Array.isArray(pkg.payload?.rows) ? pkg.payload.rows.length : 0;
      document.getElementById("packagePreview").innerHTML =
        '<div class="grid stats">' +
        stat("SYNC run", pkg.sync_run_id) +
        stat("Section", pkg.section) +
        stat("Entity", pkg.entity) +
        stat("Schema", "v" + pkg.schema_version) +
        stat("Fingerprint", pkg.package_fingerprint.slice(0, 16)) +
        stat("Generated", pkg.generated_at) +
        stat("Payload rows", rowCount) +
	        stat("Exceptions / provenance", pkg.exceptions.length + " / " + pkg.provenance.length) +
	        '</div><details><summary>View raw JSON</summary><pre>' + JSON.stringify(pkg, null, 2).replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch])) + '</pre></details>';
	    }
	    async function markSectionReady(section) {
	      if (!selectedRunId || !section) return;
	      await api("/api/runs/" + encodeURIComponent(selectedRunId) + "/sections/" + encodeURIComponent(section) + "/mark-ready", {
	        method: "POST",
	        headers: { "Content-Type": "application/json" },
	        body: JSON.stringify({ approved_by: "operator" })
	      });
	      await loadRun();
	    }
	    async function markSectionBlocked(section) {
	      if (!selectedRunId || !section) return;
	      await api("/api/runs/" + encodeURIComponent(selectedRunId) + "/sections/" + encodeURIComponent(section) + "/mark-blocked", {
	        method: "POST",
	        headers: { "Content-Type": "application/json" },
	        body: JSON.stringify({ blocked_by: "operator" })
	      });
	      await loadRun();
	    }
    async function exportAiReviewPackage(section) {
      const data = await api("/api/runs/" + encodeURIComponent(selectedRunId) + "/sections/" + encodeURIComponent(section) + "/ai-review/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_type: "full_section_review", records_mode: "warnings_blockers" })
      });
      const blob = new Blob([JSON.stringify(data.review_package, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "counterpoint-ai-review-" + section + "-" + data.review_package.package_fingerprint.slice(0, 12) + ".json";
      link.click();
      URL.revokeObjectURL(url);
      await loadSuggestions();
    }
    async function loadSuggestions() {
      if (!selectedRunId) return;
      const data = await api("/api/runs/" + encodeURIComponent(selectedRunId) + "/ai-review/suggestions");
      const rows = data.suggestions || [];
      document.getElementById("aiSuggestions").innerHTML = rows.length ? '<table><thead><tr><th>Type</th><th>Section</th><th>Risk</th><th>Confidence</th><th>Source</th><th>Target</th><th>Current</th><th>Suggested</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
        rows.map((row) => '<tr><td>' + row.suggestion_type + '</td><td>' + row.section + '</td><td>' + pill(row.risk_level, row.risk_level === "high", row.risk_level === "medium") + '</td><td>' + row.confidence + '</td><td>' + fmt(row.source_record_id) + '</td><td><code>' + row.target_path + '</code></td><td>' + fmt(JSON.stringify(row.current_value)) + '</td><td>' + fmt(JSON.stringify(row.suggested_value)) + '</td><td>' + row.status + '</td><td><button data-decision="accept" data-suggestion="' + row.suggestion_id + '">Accept</button> <button data-decision="reject" data-suggestion="' + row.suggestion_id + '">Reject</button> <button data-decision="needs_manual_review" data-suggestion="' + row.suggestion_id + '">Manual review</button></td></tr>').join("") + '</tbody></table>'
        : '<p class="muted">No AI suggestions for the selected run.</p>';
      document.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", () => decideSuggestion(button.dataset.suggestion || "", button.dataset.decision || "")));
    }
    async function decideSuggestion(suggestionId, decision) {
      await api("/api/ai-review/suggestions/" + encodeURIComponent(suggestionId) + "/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewed_by: "operator" })
      });
      await loadSuggestions();
    }
    async function applyAcceptedSuggestions(section) {
      await api("/api/runs/" + encodeURIComponent(selectedRunId) + "/sections/" + encodeURIComponent(section) + "/ai-review/apply-accepted", { method: "POST" });
      await loadRun();
    }
	    function showError(error) {
	      document.getElementById("stats").innerHTML = '<div class="card"><p class="value">Workbench request failed</p><p class="muted">' + String(error.message || error) + '</p></div>';
	    }
	    function parseCsv(text) {
	      const rows = [];
	      let row = [];
	      let cell = "";
	      let quoted = false;
	      for (let i = 0; i < text.length; i++) {
	        const ch = text[i];
	        const next = text[i + 1];
	        if (quoted && ch === '"' && next === '"') { cell += '"'; i++; continue; }
	        if (ch === '"') { quoted = !quoted; continue; }
	        if (!quoted && ch === ",") { row.push(cell); cell = ""; continue; }
	        if (!quoted && (ch === "\\n" || ch === "\\r")) {
	          if (ch === "\\r" && next === "\\n") i++;
	          row.push(cell);
	          if (row.some((value) => value.trim() !== "")) rows.push(row);
	          row = [];
	          cell = "";
	          continue;
	        }
	        cell += ch;
	      }
	      row.push(cell);
	      if (row.some((value) => value.trim() !== "")) rows.push(row);
	      const headers = (rows.shift() || []).map((value) => value.trim());
	      return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header || "column_" + index, values[index] ?? ""])));
	    }
	    async function importCsvFile(kind, file) {
	      if (!file) return;
	      const section = "catalog";
	      document.getElementById("csvStatus").textContent = "Reading " + file.name + "...";
	      const text = await file.text();
	      const rows = parseCsv(text);
	      const path = kind === "lightspeed" ? "/api/csv/lightspeed/import" : "/api/csv/counterpoint/import";
	      const result = await api(path, {
	        method: "POST",
	        headers: { "Content-Type": "application/json" },
	        body: JSON.stringify({ sync_run_id: selectedRunId || undefined, section, file_name: file.name, rows, csv_role: "inventory_product_reference" })
	      });
	      selectedRunId = result.sync_run_id || selectedRunId;
	      document.getElementById("csvStatus").textContent = "Imported " + rows.length + " " + kind + " inventory reference row(s).";
	      await refresh();
	    }
    document.getElementById("saveToken")?.addEventListener("click", () => { localStorage.setItem("counterpointSyncToken", tokenInput?.value || ""); refresh().catch(showError); });
    document.getElementById("refresh").addEventListener("click", () => refresh().catch(showError));
    document.getElementById("export").addEventListener("click", async () => {
      const data = await api("/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "counterpoint-sync-export-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      link.click();
      URL.revokeObjectURL(url);
    });
    document.getElementById("importSuggestions").addEventListener("click", async () => {
      const raw = document.getElementById("suggestionImport").value;
      const body = JSON.parse(raw);
      await api("/api/ai-review/import-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      document.getElementById("suggestionImport").value = "";
      await loadSuggestions();
    });
	    document.getElementById("reloadSuggestions").addEventListener("click", () => loadSuggestions().catch(showError));
	    document.getElementById("lightspeedCsv").addEventListener("change", (event) => importCsvFile("lightspeed", event.target.files?.[0]).catch(showError));
	    document.getElementById("counterpointCsv").addEventListener("change", (event) => importCsvFile("counterpoint", event.target.files?.[0]).catch(showError));
	    refresh().catch((error) => { document.getElementById("stats").innerHTML = '<div class="card"><p class="value">Token required</p><p class="muted">' + error.message + '</p></div>'; });
  </script>
</body>
</html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-counterpoint-sync-token",
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function authorized(req) {
  if (!TOKEN.trim()) return true;
  const headerToken = req.headers["x-counterpoint-sync-token"];
  const auth = String(req.headers.authorization ?? "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return headerToken === TOKEN || bearer === TOKEN;
}

function statusEvent(store, run, event_kind, metadata = {}) {
  store.status_events.unshift({
    id: newId("event"),
    sync_run_id: run?.sync_run_id ?? null,
    event_kind,
    metadata,
    created_at: nowIso(),
  });
  store.status_events = store.status_events.slice(0, 500);
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if ((req.url === "/" || req.url === "/ui") && req.method === "GET") {
    return sendHtml(res, 200, dashboardHtml());
  }
  if (req.url === "/health" && req.method === "GET") {
    const store = (() => {
      try {
        return loadStore();
      } catch {
        return emptyStore();
      }
    })();
    return send(res, 200, {
      ok: true,
      service: "counterpoint_sync_workbench",
      store_type: "sqlite",
      schema_version: SCHEMA_VERSION,
      token_configured: TOKEN.trim().length > 0,
      token_required: TOKEN.trim().length > 0,
      hostname: os.hostname(),
      store_path: STORE_PATH,
      store: storeHealth(),
      last_bridge_heartbeat: publicHeartbeat(store),
      summary: summarizeRuns(store),
      generated_at: nowIso(),
    });
  }
  if (!authorized(req)) return send(res, 401, { error: "invalid or missing optional SYNC Workbench token" });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const store = loadStore();

  if (req.method === "POST" && url.pathname === "/api/bridge/heartbeat") {
    const body = await readBody(req);
    store.heartbeats.unshift({ ...body, received_at: nowIso() });
    store.heartbeats = store.heartbeats.slice(0, 100);
    saveStore(store);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/bridge/batches") {
    const body = await readBody(req);
    const section = normalizeSection(body.section ?? body.entity);
    if (!section) return send(res, 400, { error: "section or entity required" });
    const run = activeRun(store, body.sync_run_id);
    const payload = body.payload ?? {};
    const batch = {
      source_batch_id: body.source_batch_id ?? newId("batch"),
      section,
      entity: section,
      source_system: body.source_system ?? "counterpoint_bridge",
      source_record_id: body.source_record_id ?? null,
      original_payload: body.original_payload ?? payload,
      normalized_payload: body.normalized_payload ?? payload,
      payload,
      row_count: rowCount(payload),
      bridge_version: body.bridge_version ?? req.headers["x-bridge-version"] ?? null,
      bridge_hostname: body.bridge_hostname ?? req.headers["x-bridge-hostname"] ?? null,
      created_at: nowIso(),
    };
    run.source_batches = run.source_batches.filter((existing) =>
      !(existing.section === section && existing.source_batch_id === batch.source_batch_id)
    );
    run.provenance = run.provenance.filter((existing) =>
      !(existing.section === section && existing.source_batch_id === batch.source_batch_id)
    );
    run.exceptions = run.exceptions.filter((existing) =>
      !(existing.section === section && existing.source_batch_id === batch.source_batch_id)
    );
    run.source_batches.push(batch);
    const sectionState = sectionFor(run, section);
    sectionState.status = sectionState.status === "not_started" ? "raw_received" : sectionState.status;
    sectionState.review_status = "raw";
    run.provenance.push({
      id: newId("prov"),
      section,
      source_system: batch.source_system,
      source_batch_id: batch.source_batch_id,
      source_record_id: batch.source_record_id,
      original_payload: batch.original_payload,
      normalized_payload: batch.normalized_payload,
      bridge_hostname: batch.bridge_hostname,
      bridge_version: batch.bridge_version,
      created_at: batch.created_at,
    });
    appendExceptions(run, section, batch.source_batch_id, body.exceptions ?? []);
    packageFor(run, section);
    run.updated_at = nowIso();
    statusEvent(store, run, "bridge_batch_received", { section, row_count: batch.row_count });
    saveStore(store);
    return send(res, 200, { ok: true, sync_run_id: run.sync_run_id, source_batch_id: batch.source_batch_id });
  }

  if (req.method === "POST" && (url.pathname === "/api/csv/lightspeed/import" || url.pathname === "/api/csv/counterpoint/import")) {
    const body = await readBody(req);
    const section = "catalog";
    const source = url.pathname.includes("lightspeed") ? "lightspeed_csv" : "counterpoint_csv";
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const run = activeRun(store, body.sync_run_id);
    run.source_batches.push({
      source_batch_id: body.source_batch_id ?? newId("csv"),
      section,
      entity: section,
      source_system: source,
      source_record_id: null,
      original_payload: { ...body, section, csv_role: "inventory_product_reference" },
      normalized_payload: { csv_role: "inventory_product_reference", rows },
      payload: { csv_role: "inventory_product_reference", rows },
      row_count: rows.length,
      bridge_version: null,
      bridge_hostname: null,
      created_at: nowIso(),
    });
    sectionFor(run, section).status = "in_review";
    packageFor(run, section);
    run.updated_at = nowIso();
    statusEvent(store, run, "csv_imported", { section, source, csv_role: "inventory_product_reference" });
    saveStore(store);
    return send(res, 200, { ok: true, sync_run_id: run.sync_run_id });
  }

  if (req.method === "GET" && url.pathname === "/api/runs") {
    return send(res, 200, { runs: store.runs.map(publicRun) });
  }

  if (req.method === "GET" && url.pathname === "/api/export") {
    return send(res, 200, exportStore());
  }

  if (req.method === "POST" && url.pathname === "/api/ai-review/import-suggestions") {
    const body = await readBody(req);
    let result;
    try {
      result = importAiSuggestions(store, body);
    } catch (error) {
      return send(res, 400, { error: error?.message ?? String(error) });
    }
    saveStore(store);
    return send(res, 200, result);
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "ai-review" && parts[2] === "suggestions" && parts[3] && parts[4] === "decision") {
    const body = await readBody(req);
    const suggestion = store.ai_suggestions.find((item) => item.suggestion_id === parts[3]);
    if (!suggestion) return send(res, 404, { error: "AI suggestion not found" });
    const decision = String(body.decision ?? "").trim();
    if (!["accept", "reject", "needs_manual_review"].includes(decision)) {
      return send(res, 400, { error: "decision must be accept, reject, or needs_manual_review" });
    }
    suggestion.status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "needs_manual_review";
    suggestion.reviewed_at = nowIso();
    suggestion.reviewed_by = body.reviewed_by ?? "operator";
    if (Object.hasOwn(body, "edited_value")) suggestion.accepted_value = body.edited_value;
    const reviewDecision = {
      decision_id: crypto.randomUUID(),
      suggestion_id: suggestion.suggestion_id,
      decision,
      edited_value: Object.hasOwn(body, "edited_value") ? body.edited_value : null,
      reviewer_note: body.reviewer_note ?? null,
      created_at: nowIso(),
      created_by: body.reviewed_by ?? "operator",
    };
    store.review_decisions.unshift(reviewDecision);
    saveStore(store);
    return send(res, 200, { ok: true, suggestion, decision: reviewDecision });
  }

  if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
    const run = store.runs.find((item) => item.sync_run_id === parts[2]);
    if (!run) return send(res, 404, { error: "SYNC run not found" });
    if (req.method === "GET" && parts.length === 3) return send(res, 200, { run: publicRunDetail(store, run) });
    if (req.method === "GET" && parts[3] === "sections") return send(res, 200, { sections: Object.values(run.sections) });
    if (req.method === "GET" && parts[3] === "exceptions") return send(res, 200, { exceptions: run.exceptions });
    if (req.method === "GET" && parts[3] === "provenance") return send(res, 200, { provenance: run.provenance });
    if (req.method === "GET" && parts[3] === "ai-review" && parts[4] === "packages") {
      return send(res, 200, {
        review_packages: store.ai_review_packages.filter((item) => item.sync_run_id === run.sync_run_id),
      });
    }
    if (req.method === "GET" && parts[3] === "ai-review" && parts[4] === "suggestions") {
      return send(res, 200, {
        suggestions: store.ai_suggestions.filter((item) => item.sync_run_id === run.sync_run_id),
      });
    }
    if (req.method === "GET" && parts[3] === "packages" && parts.length === 4) {
      for (const section of Object.keys(run.sections)) packageFor(run, section);
      saveStore(store);
      return send(res, 200, { packages: Object.values(run.packages) });
    }
    if (req.method === "GET" && parts[3] === "packages" && parts[4]) {
      const pkg = packageFor(run, parts[4]);
      saveStore(store);
      return send(res, 200, pkg);
    }
    if (req.method === "POST" && parts[3] === "sections" && parts[4] && parts[5] === "ai-review" && parts[6] === "export") {
      const body = await readBody(req);
      const reviewPackage = createAiReviewPackage(
        store,
        run,
        parts[4],
        body.review_type ?? "full_section_review",
        body.records_mode ?? "warnings_blockers",
      );
      saveStore(store);
      return send(res, 200, { review_package: reviewPackage });
    }
    if (req.method === "POST" && parts[3] === "sections" && parts[4] && parts[5] === "ai-review" && parts[6] === "apply-accepted") {
      const result = applyAcceptedSuggestions(store, run.sync_run_id, parts[4]);
      saveStore(store);
      return send(res, 200, result);
    }
    if (req.method === "POST" && parts[3] === "sections" && parts[4] && parts[5] === "mark-ready") {
      const body = await readBody(req);
      const section = sectionFor(run, parts[4]);
      if (section.blockers > 0) {
        return send(res, 409, { error: "Section has unresolved blockers and cannot be marked ready." });
      }
      section.status = section.blockers > 0 ? "ready_with_warnings" : (section.warnings > 0 ? "ready_with_warnings" : "ready");
      section.review_status = "approved";
      section.approved_at = nowIso();
      section.approved_by = body.approved_by ?? "operator";
      run.status = "ready_for_ros_review";
      run.updated_at = nowIso();
      packageFor(run, parts[4]);
      statusEvent(store, run, "section_marked_ready", { section: section.section });
      saveStore(store);
      return send(res, 200, { ok: true, section });
    }
    if (req.method === "POST" && parts[3] === "sections" && parts[4] && parts[5] === "mark-imported") {
      const body = await readBody(req);
      const section = sectionFor(run, parts[4]);
      section.status = "imported";
      section.imported_at = nowIso();
      section.ros_import_run_id = body.ros_import_run_id ?? null;
      section.imported_package_fingerprint = body.package_fingerprint ?? section.package_fingerprint ?? null;
      section.updated_at = nowIso();
      run.updated_at = nowIso();
      if (Object.values(run.sections).length > 0 && Object.values(run.sections).every((item) => item.status === "imported")) {
        run.status = "imported_to_ros";
      }
      statusEvent(store, run, "section_imported_to_ros", {
        section: section.section,
        ros_import_run_id: section.ros_import_run_id,
        package_fingerprint: section.imported_package_fingerprint,
      });
      saveStore(store);
      return send(res, 200, { ok: true, section, run: publicRun(run) });
    }
    if (req.method === "POST" && parts[3] === "sections" && parts[4] && parts[5] === "mark-blocked") {
      const body = await readBody(req);
      const section = sectionFor(run, parts[4]);
      section.status = "blocked";
      section.blockers += 1;
      run.status = "blocked";
      run.exceptions.push({
        id: newId("exc"),
        section: section.section,
        severity: "blocker",
        status: "open",
        message: body.message ?? "Section blocked for SYNC review.",
        source_payload: body.source_payload ?? {},
        created_at: nowIso(),
      });
      run.updated_at = nowIso();
      packageFor(run, parts[4]);
      statusEvent(store, run, "section_marked_blocked", { section: section.section });
      saveStore(store);
      return send(res, 200, { ok: true, section });
    }
    if (req.method === "POST" && parts[3] === "finalize") {
      run.status = "ready_for_ros_review";
      run.updated_at = nowIso();
      for (const section of Object.keys(run.sections)) packageFor(run, section);
      statusEvent(store, run, "run_finalized");
      saveStore(store);
      return send(res, 200, { ok: true, run: publicRun(run) });
    }
  }

  return send(res, 404, { error: "not found" });
}

http.createServer((req, res) => {
  const runRoute = () => route(req, res).catch((error) => {
    console.error("[sync-workbench]", error);
    send(res, 500, { error: error?.message ?? String(error) });
  });
  const next = writeRouteLock.then(runRoute, runRoute);
  writeRouteLock = next.catch(() => undefined);
}).listen(PORT, HOST, () => {
  console.log(`Counterpoint SYNC Workbench listening at http://${HOST}:${PORT}`);
});
