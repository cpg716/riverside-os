#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
loadEnv(path.join(rootDir, ".env"));

const BASE_URL = (process.env.COUNTERPOINT_SYNC_WORKBENCH_URL ?? "http://127.0.0.1:3015").replace(/\/+$/u, "");
const TOKEN = process.env.COUNTERPOINT_SYNC_WORKBENCH_TOKEN ?? "";
const RUN_ID = process.env.COUNTERPOINT_SYNC_SIM_RUN_ID ?? deterministicUuid("riverside-counterpoint-sync-simulation-v1");
const SIM_TS = "2026-01-15T12:00:00.000Z";
const SOURCE_SYSTEM = "counterpoint_bridge_simulator";

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

async function post(pathname, body) {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN.trim()) {
    headers.Authorization = `Bearer ${TOKEN}`;
    headers["x-counterpoint-sync-token"] = TOKEN;
  }
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${pathname} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function get(pathname) {
  const headers = {};
  if (TOKEN.trim()) {
    headers.Authorization = `Bearer ${TOKEN}`;
    headers["x-counterpoint-sync-token"] = TOKEN;
  }
  const res = await fetch(`${BASE_URL}${pathname}`, {
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${pathname} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function batch(section, rows, exceptions = []) {
  return {
    sync_run_id: RUN_ID,
    source_batch_id: `sim_${section}_batch_001`,
    section,
    entity: section,
    source_system: SOURCE_SYSTEM,
    bridge_version: "simulator-1.0.0",
    bridge_hostname: "counterpoint-simulator",
    original_payload: {
      simulation_only: true,
      fixture_version: 1,
      extracted_at: SIM_TS,
      section,
      rows,
    },
    normalized_payload: { rows },
    payload: { rows },
    exceptions,
  };
}

const fixtures = [
  batch("vendors", [
    { vendor_code: "VEND-TUX", name: "Tuxedo Supply Co", phone: "555-0100", email: "orders@tuxedo.example" },
    { vendor_code: "VEND-ALT", name: "Alterations Partner", phone: "", email: "" },
  ], [
    {
      severity: "warning",
      code: "vendor_optional_contact_missing",
      message: "Vendor VEND-ALT is missing optional contact information.",
      source_record_id: "VEND-ALT",
      original_value: "",
      recommended_action: "Review vendor contact details in SYNC before final go-live.",
    },
  ]),
  batch("customers", [
    { cust_no: "CUST-100", first_name: "Avery", last_name: "Stone", email: "avery@example.test", phone: "(555) 010-1000" },
    { cust_no: "CUST-101", first_name: "Blake", last_name: "Stone", email: "avery@example.test", phone: "555.010.1001" },
    { cust_no: "CUST-102", first_name: "Casey", last_name: "Noemail", email: "", phone: "+1 555 010 1002 ext 7" },
  ], [
    {
      severity: "warning",
      code: "duplicate_customer_email",
      message: "Duplicate customer email should import with email omitted and provenance retained.",
      source_record_id: "CUST-101",
      original_value: "avery@example.test",
      recommended_action: "Confirm customer identity; ROS should preserve original email in import exception/provenance.",
    },
    {
      severity: "warning",
      code: "customer_missing_email",
      message: "Customer CUST-102 has no email address.",
      source_record_id: "CUST-102",
      original_value: "",
      recommended_action: "Accept if no email exists in Counterpoint, or add one during SYNC review.",
    },
    {
      severity: "warning",
      code: "customer_odd_phone_format",
      message: "Customer CUST-102 has an unusual phone format.",
      source_record_id: "CUST-102",
      original_value: "+1 555 010 1002 ext 7",
      recommended_action: "Verify phone formatting before final import if SMS/contact workflows depend on it.",
    },
  ]),
  batch("catalog", [
    { item_no: "ITEM-TUX-001", sku: "TUX-001", barcode: "100000001", description: "Classic black tuxedo jacket", vendor_code: "VEND-TUX" },
    { item_no: "ITEM-SHIRT-001", sku: "SHIRT-001", barcode: "", description: "Wing collar shirt", vendor_code: "VEND-TUX" },
  ], [
    {
      severity: "warning",
      code: "catalog_missing_barcode",
      message: "Catalog row ITEM-SHIRT-001 is missing a barcode.",
      source_record_id: "ITEM-SHIRT-001",
      original_value: "",
      recommended_action: "Add barcode in SYNC if scanner checkout requires this item.",
    },
  ]),
  batch("inventory", [
    { item_no: "ITEM-TUX-001", sku: "TUX-001", location: "MAIN", quantity_on_hand: 3 },
    { item_no: "ITEM-MISSING-404", sku: "MISSING-404", location: "MAIN", quantity_on_hand: 2 },
  ], [
    {
      severity: "blocker",
      code: "inventory_missing_catalog_item",
      message: "Inventory row references ITEM-MISSING-404, which is not present in the simulated catalog package.",
      source_record_id: "ITEM-MISSING-404",
      original_value: "ITEM-MISSING-404",
      recommended_action: "Map the item to a prepared catalog row or block inventory import until catalog is corrected.",
    },
  ]),
  batch("gift_cards", [
    { card_number: "SIM-GC-100", balance: "25.00", status: "active", issued_at: "2025-12-01" },
  ], [
    {
      severity: "warning",
      code: "simulation_only_gift_card",
      message: "Gift card fixture is simulation-only and should not be imported into production ROS.",
      source_record_id: "SIM-GC-100",
      original_value: "25.00",
      recommended_action: "Use only in a safe dev database.",
    },
  ]),
];

async function main() {
  await post("/api/bridge/heartbeat", {
    simulation_only: true,
    bridge_hostname: "counterpoint-simulator",
    bridge_version: "simulator-1.0.0",
    phase: "syncing",
    last_successful_extraction: SIM_TS,
    target_sync_reachable: true,
  });

  for (const fixture of fixtures) {
    await post("/api/bridge/batches", fixture);
  }

  for (const section of ["vendors", "customers", "catalog", "gift_cards"]) {
    try {
      await post(`/api/runs/${RUN_ID}/sections/${section}/mark-ready`, { approved_by: "simulator" });
    } catch (error) {
      console.warn(`[simulate-counterpoint] ${section} not marked ready: ${error.message}`);
    }
  }
  await post(`/api/runs/${RUN_ID}/finalize`, {});

  const packages = await get(`/api/runs/${RUN_ID}/packages`);
  console.log(JSON.stringify({
    ok: true,
    simulation_only: true,
    sync_run_id: RUN_ID,
    workbench_url: BASE_URL,
    sections: packages.packages.map((pkg) => ({
      section: pkg.section,
      fingerprint: pkg.package_fingerprint,
      raw: pkg.source_counts.raw,
      prepared: pkg.source_counts.prepared,
      warnings: pkg.source_counts.warnings,
      blockers: pkg.source_counts.blockers,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(`[simulate-counterpoint] ${error?.message ?? String(error)}`);
  process.exitCode = 1;
});
