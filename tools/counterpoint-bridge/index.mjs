/**
 * Counterpoint → Riverside OS bridge (Windows-friendly).
 * Run on the Counterpoint SQL host: npm install && npm start
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

const ROS_BASE_URL = (process.env.ROS_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SYNC_TOKEN = process.env.COUNTERPOINT_SYNC_TOKEN ?? "";
const CONN = process.env.SQL_CONNECTION_STRING ?? "";
const POLL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10);
const BATCH = Math.max(1, Number.parseInt(process.env.BATCH_SIZE ?? "200", 10));
const STATE_FILE = process.env.CURSOR_STATE_FILE ?? path.join(__dirname, ".counterpoint-bridge-state.json");
const SYNC_CUSTOMERS = process.env.SYNC_CUSTOMERS !== "0";
const SYNC_INVENTORY = process.env.SYNC_INVENTORY === "1";
const CP_CUSTOMERS_QUERY = process.env.CP_CUSTOMERS_QUERY ?? "";
const CP_INVENTORY_QUERY = process.env.CP_INVENTORY_QUERY ?? "";

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

async function rosFetch(path, body) {
  const url = `${ROS_BASE_URL}${path}`;
  const headers = {
    "Content-Type": "application/json",
    "x-ros-sync-token": SYNC_TOKEN,
  };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      if (!res.ok) {
        lastErr = new Error(`ROS ${res.status}: ${text.slice(0, 500)}`);
      } else {
        return json;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastErr;
}

async function rosGetHealth() {
  const url = `${ROS_BASE_URL}/api/sync/counterpoint/health`;
  const res = await fetch(url, { headers: { "x-ros-sync-token": SYNC_TOKEN } });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

/** SQL Server often returns column names in upper case; ROS expects lowercase JSON keys. */
function normalizeRowKeys(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function mapCustomerRow(r) {
  return {
    cust_no: String(r.cust_no ?? "").trim(),
    first_name: r.first_name ?? undefined,
    last_name: r.last_name ?? undefined,
    full_name: r.full_name ?? undefined,
    company_name: r.company_name ?? undefined,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    address_line1: r.address_line1 ?? undefined,
    address_line2: r.address_line2 ?? undefined,
    city: r.city ?? undefined,
    state: r.state ?? undefined,
    postal_code: r.postal_code ?? undefined,
    date_of_birth: r.date_of_birth ?? undefined,
    marketing_email_opt_in: r.marketing_email_opt_in ?? undefined,
    marketing_sms_opt_in: r.marketing_sms_opt_in ?? undefined,
  };
}

function mapInventoryRow(r) {
  return {
    sku: String(r.sku ?? "").trim(),
    stock_on_hand: Number.parseInt(String(r.stock_on_hand ?? "0"), 10) || 0,
    counterpoint_item_key: r.counterpoint_item_key
      ? String(r.counterpoint_item_key).trim()
      : undefined,
    unit_cost:
      r.unit_cost !== undefined && r.unit_cost !== null
        ? String(r.unit_cost)
        : undefined,
  };
}

async function syncCustomers(pool) {
  if (!CP_CUSTOMERS_QUERY.trim()) {
    console.warn("[customers] CP_CUSTOMERS_QUERY empty; skip");
    return;
  }
  const state = readState();
  const result = await pool.request().query(CP_CUSTOMERS_QUERY);
  const rows = result.recordset ?? [];
  if (rows.length === 0) {
    console.info("[customers] no rows");
    return;
  }

  console.info("[customers] SQL returned", rows.length, "row(s); sending in batches of", BATCH);
  const mapped = rows.map((row) => mapCustomerRow(normalizeRowKeys(row))).filter((r) => r.cust_no);
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.cust_no;
    const body = {
      rows: chunk,
      sync: { entity: "customers", cursor: last },
    };
    const summary = await rosFetch("/api/sync/counterpoint/customers", body);
    console.info("[customers] batch", summary);
    if (last) {
      state.customers_cursor = last;
      writeState(state);
    }
  }
}

async function syncInventory(pool) {
  if (!CP_INVENTORY_QUERY.trim()) {
    console.warn("[inventory] CP_INVENTORY_QUERY empty; skip");
    return;
  }
  const state = readState();
  const result = await pool.request().query(CP_INVENTORY_QUERY);
  const rows = result.recordset ?? [];
  const mapped = rows.map((row) => mapInventoryRow(normalizeRowKeys(row))).filter((r) => r.sku);
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const body = {
      rows: chunk,
      sync: { entity: "inventory", cursor: String(i + chunk.length) },
    };
    const summary = await rosFetch("/api/sync/counterpoint/inventory", body);
    console.info("[inventory] batch", summary);
    state.inventory_cursor = String(i + chunk.length);
    writeState(state);
  }
}

async function main() {
  if (!SYNC_TOKEN.trim()) {
    console.error("Set COUNTERPOINT_SYNC_TOKEN");
    process.exit(1);
  }
  if (!CONN.trim()) {
    console.error("Set SQL_CONNECTION_STRING");
    process.exit(1);
  }
  await rosGetHealth();
  console.info("ROS sync health OK");

  const pool = new sql.ConnectionPool(CONN);
  pool.on("error", (err) => console.error("SQL pool error", err));
  await pool.connect();
  console.info("SQL Server connected");

  const tick = async () => {
    try {
      if (SYNC_CUSTOMERS) await syncCustomers(pool);
      if (SYNC_INVENTORY) await syncInventory(pool);
    } catch (e) {
      console.error("sync tick failed", e.message ?? e);
    }
  };

  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
