/**
 * Counterpoint → Riverside OS bridge (Windows-friendly).
 * Run on the Counterpoint SQL host: npm install && npm start
 * Schema probe: npm run discover or DISCOVER_SCHEMA.cmd (SQL only; no ROS token).
 *
 * Entities: staff/users, optional SLS_REP stubs, customers, store credit (optional), inventory, catalog,
 * gift cards, tickets, open PS_DOC orders (optional).
 * Heartbeat: idle/syncing each poll cycle; bridge polls for pending sync requests.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import http from 'node:http';

// --- Global State for Dashboard ---
const LOG_BACKLOG = [];
const logToDashboard = (msg) => {
    const entry = { time: new Date().toLocaleTimeString(), msg };
    LOG_BACKLOG.push(entry);
    if (LOG_BACKLOG.length > 200) LOG_BACKLOG.shift();
    console.log(`[${entry.time}] ${msg}`);
    
    // Write to persistent log file
    try {
        const logFile = path.join(__dirname, 'bridge-execution.log');
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {
        // Silently fail if file write fails (e.g. permissions)
    }
};

const BRIDGE_STATE = {
    isContinuous: false,
    isSyncing: false,
    currentEntity: null,
    lastRun: null,
    error: null,
    syncSummary: {} // Track which entities have completed successfully
};

const ENTITY_DEPENDENCIES = {
    'inventory': ['catalog'],
    'tickets': ['customers', 'catalog'],
    'vendor_items': ['vendors', 'catalog'],
    'open_docs': ['customers', 'catalog'],
    'customer_notes': ['customers'],
    'receiving_history': ['vendors', 'catalog']
};


// --- Local Bridge Control Server ---
const startLocalServer = () => {
    http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (req.method === 'OPTIONS') { res.end(); return; }

        if (req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                ...BRIDGE_STATE, 
                logs: LOG_BACKLOG,
                runOnce: process.env.RUN_ONCE === "1"
            }));
        } else if (req.url === '/api/settings') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.run_once !== undefined) {
                      process.env.RUN_ONCE = data.run_once ? "1" : "0";
                      logToDashboard(`Mode changed: ${data.run_once ? "IMPORT (Once)" : "SYNC (Continuous 15m)"}`);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(e.message);
                }
            });
        } else if (req.url.startsWith('/api/proxy/ros')) {
            // Proxy request to Riverside OS using the bridge's internal token
            const url = new URL(req.url, `http://${req.headers.host}`);
            const rosPath = url.searchParams.get('path');
            const method = url.searchParams.get('method') || 'GET';
            
            if (!rosPath) {
                res.writeHead(400);
                res.end("Missing 'path' parameter");
                return;
            }

            const fullUrl = `${ROS_BASE_URL}${rosPath}`;
            logToDashboard(`[proxy] Forwarding ${method} to Riverside: ${rosPath}`);

            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'x-ros-sync-token': SYNC_TOKEN
                }
            };

            const proxyReq = http.request(fullUrl, options, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });

            proxyReq.on('error', (err) => {
                logToDashboard(`[proxy] Request failed: ${err.message}`);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            });

            if (method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => { proxyReq.end(body); });
            } else {
                proxyReq.end();
            }
        } else if (req.url.startsWith('/api/trigger-entity')) {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const entity = url.searchParams.get('name');
            logToDashboard(`Manual trigger: Targeted pull for [${entity}] requested`);
            
            // Resolve dependencies
            const deps = ENTITY_DEPENDENCIES[entity] || [];
            const toRun = [...deps, entity];
            
            logToDashboard(`[dependency-check] To complete [${entity}], we will run: ${toRun.join(' -> ')}`);
            
            (async () => {
                BRIDGE_STATE.isSyncing = true;
                const steps = getOrderedSyncSteps();
                for (const target of toRun) {
                    const step = steps.find(s => s.label === target);
                    if (step) {
                        logToDashboard(`[${target}] starting targeted sync...`);
                        await sendHeartbeat("syncing", step.hb);
                        await runSyncEntity(step.label, step.run);
                        BRIDGE_STATE.syncSummary[target] = new Date().toISOString();
                        logToDashboard(`[${target}] ok`);
                    }
                }
                BRIDGE_STATE.isSyncing = false;
                logToDashboard(`[sync] Targeted pull for ${entity} finished.`);
            })().catch(err => {
                BRIDGE_STATE.isSyncing = false;
                logToDashboard(`Sync error: ${err.message}`);
            });

            res.end(JSON.stringify({ status: 'triggered', queue: toRun }));
        } else if (req.url === '/') {
            const htmlPath = path.join(__dirname, 'dashboard.html');
            if (fs.existsSync(htmlPath)) {
                const html = fs.readFileSync(htmlPath, 'utf8');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
            } else {
                res.writeHead(404);
                res.end('Dashboard file not found');
            }
        } else {
            res.writeHead(404);
            res.end();
        }
    }).listen(3002, () => {
        console.log("🌐 Bridge Command UI available at: http://localhost:3002");
    });
};

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

const STATE_FILE = process.env.CURSOR_STATE_FILE ?? path.join(__dirname, ".counterpoint-bridge-state.json");
const CP_IMPORT_SINCE = (process.env.CP_IMPORT_SINCE ?? "2021-01-01").trim();

// Helper to get the starting date for queries (either .env default or last success)
function getSyncAnchorDate(entityKey) {
  const state = readState();
  const lastDate = state[`${entityKey}_last_date`];
  return lastDate || CP_IMPORT_SINCE;
}

/** Replaces __CP_IMPORT_SINCE__ with anchor date */
function expandImportSince(sqlText, anchorDate = CP_IMPORT_SINCE) {
  if (sqlText == null) return "";
  return String(sqlText).replace(/__CP_IMPORT_SINCE__/g, anchorDate);
}

/**
 * Counterpoint schema drift filters
 */
function omitPsTktDocTypFilterEnabled() {
  const v = (process.env.CP_OMIT_PS_TKT_DOC_TYP_FILTER ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * When IM_ITEM uses a vendor code column other than VEND_NO, set CP_IM_ITEM_VENDOR_COLUMN (SSMS / discover).
 * Replaces `i.VEND_NO` only (IM_ITEM alias i).
 */
function applyImItemVendorColumn(sqlText) {
  const col = (process.env.CP_IM_ITEM_VENDOR_COLUMN ?? "").trim();
  if (!col || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) return String(sqlText ?? "");
  return String(sqlText).replace(/\bi\.VEND_NO\b/g, `i.${col}`);
}

/** Use PO_VEND_ITEM to link items to vendors when IM_ITEM has no VEND_NO-style column (CP_IM_ITEM_VENDOR_SOURCE=po_vend_item). */
function poVendItemVendorLinkEnabled() {
  const v = (process.env.CP_IM_ITEM_VENDOR_SOURCE ?? "").trim().toLowerCase();
  return v === "po_vend_item" || v === "vend_item" || v === "1";
}

function applyPoVendItemVendorLink(sqlText) {
  if (!poVendItemVendorLinkEnabled()) return String(sqlText ?? "");
  let q = String(sqlText ?? "");
  q = q.replace(
    /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+IM_ITEM\s+i\s+WHERE\s+RTRIM\s*\(\s*LTRIM\s*\(\s*i\.VEND_NO\s*\)\s*\)\s*=\s*RTRIM\s*\(\s*LTRIM\s*\(\s*v\.VEND_NO\s*\)\s*\)\s+AND/gi,
    "EXISTS (SELECT 1 FROM PO_VEND_ITEM vi_link INNER JOIN IM_ITEM i ON i.ITEM_NO = vi_link.ITEM_NO WHERE RTRIM(LTRIM(vi_link.VEND_NO)) = RTRIM(LTRIM(v.VEND_NO)) AND",
  );
  q = q.replace(
    /RTRIM\s*\(\s*LTRIM\s*\(\s*i\.VEND_NO\s*\)\s*\)\s+AS\s+vend_no/gi,
    "(SELECT TOP 1 RTRIM(LTRIM(vi_cp.VEND_NO)) FROM PO_VEND_ITEM vi_cp WHERE vi_cp.ITEM_NO = i.ITEM_NO ORDER BY vi_cp.VEND_NO) AS vend_no",
  );
  return q;
}

function pipeImItemVendorSql(sqlText) {
  const exp = expandImportSince(sqlText ?? "");
  return applyImItemVendorColumn(applyPoVendItemVendorLink(exp));
}

function applyCounterpointSqlCompat(sqlText) {
  let q = String(sqlText ?? "");
  if (omitPsTktDocTypFilterEnabled()) {
    q = q.replace(/\s+AND\s+h\.DOC_TYP\s*=\s*N'T'/gi, "");
    q = q.replace(/\s+AND\s+h\.DOC_TYP\s*=\s*'T'/gi, "");
    q = q.replace(/\s+AND\s+DOC_TYP\s*=\s*N'T'/gi, "");
    q = q.replace(/\s+AND\s+DOC_TYP\s*=\s*'T'/gi, "");
    q = q.replace(/\bWHERE\s+h\.DOC_TYP\s*=\s*N'T'\s+AND\b/gi, "WHERE ");
    q = q.replace(/\bWHERE\s+h\.DOC_TYP\s*=\s*'T'\s+AND\b/gi, "WHERE ");
    q = q.replace(/\bWHERE\s+DOC_TYP\s*=\s*'T'\s+AND\b/gi, "WHERE ");
    q = q.replace(/\bWHERE\s+DOC_TYP\s*=\s*N'T'\s+AND\b/gi, "WHERE ");
    return q;
  }
  const col = (process.env.CP_TKT_DOC_TYP_COLUMN ?? "").trim();
  if (col && col !== "DOC_TYP" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
    q = q.replace(/\bh\.DOC_TYP\b/g, `h.${col}`);
    q = q.replace(/\bDOC_TYP\s*=\s*'T'/g, `${col} = 'T'`);
    q = q.replace(/\bDOC_TYP\s*=\s*N'T'/g, `${col} = N'T'`);
  }
  return q;
}

/**
 * When SYNC_STORE_CREDIT_OPENING=1, append OR EXISTS(`CP_CUSTOMER_STORE_CREDIT_EXISTS`) before ORDER BY
 * so customers with store credit import even without ticket/note in-range. Fragment must correlate to `c.CUST_NO`.
 */
/** Tail of default CP_CUSTOMERS_QUERY: close NOTE_DAT literal, close EXISTS + outer WHERE, then ORDER BY alias */
const CP_CUSTOMERS_STORE_CREDIT_TAIL = /'\)\)\s*ORDER\s+BY\s+c\.CUST_NO\s*;?\s*$/i;

function injectStoreCreditCustomerExistsClause(sqlText, storeCreditOn, existsInner) {
  const q = String(sqlText ?? "");
  const inner = String(existsInner ?? "").trim();
  if (!storeCreditOn || !q.trim() || !inner) return q;
  if (!CP_CUSTOMERS_STORE_CREDIT_TAIL.test(q)) {
    console.warn(
      "[customers] SYNC_STORE_CREDIT_OPENING=1: CP_CUSTOMERS_QUERY must end with \"')) ORDER BY c.CUST_NO\" (any case; optional trailing ;) for auto-append, or add OR EXISTS(…) manually.",
    );
    return q;
  }
  const frag = `' ) OR EXISTS (${inner})) ORDER BY c.CUST_NO`;
  return q.replace(CP_CUSTOMERS_STORE_CREDIT_TAIL, frag);
}

/** Read-only probe: `node index.mjs discover` — needs SQL_CONNECTION_STRING only (no ROS token). */
const DISCOVER_MODE =
  process.argv.includes("discover") || String(process.env.DISCOVER ?? "").toLowerCase() === "1";

const ROS_BASE_URL = (process.env.ROS_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SYNC_TOKEN = process.env.COUNTERPOINT_SYNC_TOKEN ?? "";
const CONN = process.env.SQL_CONNECTION_STRING ?? "";
/** mssql default requestTimeout is 15s — large EXISTS / ticket-scoped queries often exceed that on real CP DBs. */
const SQL_REQUEST_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.SQL_REQUEST_TIMEOUT_MS ?? "600000", 10));
const SQL_CONNECT_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.SQL_CONNECT_TIMEOUT_MS ?? "60000", 10));
/** Node fetch has no default body timeout; large vendor/customer batches to ROS need a high ceiling. */
const ROS_FETCH_TIMEOUT_MS = Math.max(15000, Number.parseInt(process.env.ROS_FETCH_TIMEOUT_MS ?? "300000", 10));

/**
 * mssql only parses timeouts when config is a merged object (server/user/…).
 * `{ connectionString, requestTimeout }` leaves server undefined — requestTimeout is ignored and Tedious stays at 15s.
 */
function createSqlPool() {
  const conn = CONN.trim();
  if (!conn) return new sql.ConnectionPool(conn);
  try {
    const parsed = sql.ConnectionPool.parseConnectionString(conn);
    return new sql.ConnectionPool({
      ...parsed,
      requestTimeout: SQL_REQUEST_TIMEOUT_MS,
      connectionTimeout: SQL_CONNECT_TIMEOUT_MS,
    });
  } catch (e) {
    console.warn("[sql] parseConnectionString failed; falling back to raw string (add Request Timeout=600000 to the string):", e?.message ?? e);
    return new sql.ConnectionPool(conn);
  }
}
const POLL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "900000", 10);
const RUN_ONCE =
  process.env.RUN_ONCE === "1" || String(process.env.COUNTERPOINT_SYNC_ONCE ?? "").toLowerCase() === "true";
/** When RUN_ONCE=1, wait for Enter before exiting so the console window stays open (Windows-friendly). Set to 0 to exit immediately. */
const WAIT_AFTER_RUN_ONCE =
  process.env.WAIT_AFTER_RUN_ONCE !== "0" && String(process.env.WAIT_AFTER_RUN_ONCE ?? "").toLowerCase() !== "false";
const BATCH = Math.max(1, Number.parseInt(process.env.BATCH_SIZE ?? "200", 10));
const SYNC_CUSTOMERS = process.env.SYNC_CUSTOMERS === "1";
const SYNC_INVENTORY = process.env.SYNC_INVENTORY === "1";
const SYNC_CATALOG = process.env.SYNC_CATALOG === "1";
const SYNC_GIFT_CARDS = process.env.SYNC_GIFT_CARDS === "1";
const SYNC_TICKETS = process.env.SYNC_TICKETS === "1";
const SYNC_VENDORS = process.env.SYNC_VENDORS === "1";
/** When not 1, vendors use a fast `PO_VEND`-only query (bulk migration). Set to 1 to run heavy filtered CP_VENDORS_QUERY (active items / ticket EXISTS). */
const SYNC_VENDORS_FILTERED = process.env.SYNC_VENDORS_FILTERED === "1";
const SYNC_CUSTOMER_NOTES = process.env.SYNC_CUSTOMER_NOTES === "1";
const SYNC_CATEGORY_MASTERS = process.env.SYNC_CATEGORY_MASTERS !== "0";
const SYNC_STAFF = process.env.SYNC_STAFF === "1";
const SYNC_LOYALTY_HIST = process.env.SYNC_LOYALTY_HIST === "1";
const SYNC_VENDOR_ITEMS = process.env.SYNC_VENDOR_ITEMS === "1";
const SYNC_STORE_CREDIT_OPENING = process.env.SYNC_STORE_CREDIT_OPENING === "1";
const SYNC_OPEN_DOCS = process.env.SYNC_OPEN_DOCS === "1";
const SYNC_RECEIVING_HISTORY = process.env.SYNC_RECEIVING_HISTORY === "1";
const SYNC_TICKET_NOTES = process.env.SYNC_TICKET_NOTES === "1";
const CP_CUSTOMER_STORE_CREDIT_EXISTS_RAW = process.env.CP_CUSTOMER_STORE_CREDIT_EXISTS ?? "";
const CP_CUSTOMERS_QUERY = injectStoreCreditCustomerExistsClause(
  applyCounterpointSqlCompat(expandImportSince(process.env.CP_CUSTOMERS_QUERY ?? "")),
  SYNC_STORE_CREDIT_OPENING,
  expandImportSince(CP_CUSTOMER_STORE_CREDIT_EXISTS_RAW),
);
const CP_INVENTORY_QUERY = applyCounterpointSqlCompat(
  expandImportSince(process.env.CP_INVENTORY_QUERY ?? ""),
);
const CP_CATALOG_QUERY = applyCounterpointSqlCompat(
  pipeImItemVendorSql(process.env.CP_CATALOG_QUERY ?? ""),
);
const CP_CATALOG_CELLS_QUERY = applyCounterpointSqlCompat(
  expandImportSince(process.env.CP_CATALOG_CELLS_QUERY ?? ""),
);
const CP_GIFT_CARDS_QUERY = expandImportSince(process.env.CP_GIFT_CARDS_QUERY ?? "");
const CP_GFT_CERT_HIST_QUERY = expandImportSince(process.env.CP_GFT_CERT_HIST_QUERY ?? "");
const CP_TICKETS_QUERY = applyCounterpointSqlCompat(
  expandImportSince(process.env.CP_TICKETS_QUERY ?? "").replace(/ORDER\s+BY\s+.*$/i, ""),
);
const CP_TICKET_LINES_QUERY = applyCounterpointSqlCompat(
  expandImportSince(process.env.CP_TICKET_LINES_QUERY ?? ""),
);
const CP_TICKET_PAYMENTS_QUERY = applyCounterpointSqlCompat(
  expandImportSince(process.env.CP_TICKET_PAYMENTS_QUERY ?? ""),
);
const CP_TICKET_CELLS_QUERY = applyCounterpointSqlCompat(
  expandImportSince(process.env.CP_TICKET_CELLS_QUERY ?? ""),
);
const CP_TICKET_GIFT_QUERY = expandImportSince(process.env.CP_TICKET_GIFT_QUERY ?? "");
const CP_LOYALTY_HIST_QUERY = expandImportSince(process.env.CP_LOYALTY_HIST_QUERY ?? "");
const CP_VEND_ITEM_QUERY = applyCounterpointSqlCompat(
  applyImItemVendorColumn(expandImportSince(process.env.CP_VEND_ITEM_QUERY ?? "")),
);
const CP_VENDORS_QUERY = applyCounterpointSqlCompat(
  pipeImItemVendorSql(process.env.CP_VENDORS_QUERY ?? ""),
);
const CP_CUSTOMER_NOTES_QUERY = expandImportSince(process.env.CP_CUSTOMER_NOTES_QUERY ?? "");
const CP_CATEGORY_MASTERS_QUERY = expandImportSince(process.env.CP_CATEGORY_MASTERS_QUERY ?? "");
const CP_USERS_QUERY = expandImportSince(process.env.CP_USERS_QUERY ?? "");
const CP_SALES_REPS_QUERY = expandImportSince(process.env.CP_SALES_REPS_QUERY ?? "");
const CP_BUYERS_QUERY = expandImportSince(process.env.CP_BUYERS_QUERY ?? "");
const CP_STORE_CREDIT_QUERY = expandImportSince(process.env.CP_STORE_CREDIT_QUERY ?? "");
const CP_OPEN_DOCS_QUERY = expandImportSince(process.env.CP_OPEN_DOCS_QUERY ?? "");
const CP_OPEN_DOC_LINES_QUERY = expandImportSince(process.env.CP_OPEN_DOC_LINES_QUERY ?? "");
const CP_OPEN_DOC_PMT_QUERY = expandImportSince(process.env.CP_OPEN_DOC_PMT_QUERY ?? "");
const CP_RECEIVING_HISTORY_QUERY = expandImportSince(process.env.CP_RECEIVING_HISTORY_QUERY ?? "");
const CP_TICKET_NOTES_QUERY = expandImportSince(process.env.CP_TICKET_NOTES_QUERY ?? "");
const BRIDGE_VERSION = "0.7.3";

/** Fast vendor list — no IM_ITEM / PS_TKT_HIST joins (avoids timeouts & missing DOC_TYP / VEND_NO). */
const CP_VENDORS_QUERY_SIMPLE = `SELECT RTRIM(LTRIM(VEND_NO)) AS vend_no, RTRIM(LTRIM(NAM)) AS name, RTRIM(LTRIM(TERMS_COD)) AS payment_terms FROM PO_VEND WHERE VEND_NO IS NOT NULL ORDER BY VEND_NO`;

/** When `SYNC_VENDORS_FILTERED` is not 1, optional full SQL override for the fast path (PO_VEND column drift). */
const CP_VENDORS_FAST_QUERY = expandImportSince(process.env.CP_VENDORS_FAST_QUERY ?? "").trim();

/** After SY_USR: infer `SLS_REP` codes from AR_CUST + PS_TKT_HIST when PS_SLS_REP table is not used. */
const SYNC_SLS_REP_STUBS = SYNC_STAFF && !CP_SALES_REPS_QUERY.trim();

/**
 * When unset/false, startup enforces ROS-safe SYNC_* combinations (full seed / catch-up).
 * Set SYNC_RELAXED_DEPENDENCIES=1 (or COUNTERPOINT_SYNC_RELAXED=true) for expert incremental runs only
 * (e.g. inventory-only refresh when ROS already has catalog + variants).
 */
const SYNC_RELAXED_DEPENDENCIES =
  process.env.SYNC_RELAXED_DEPENDENCIES === "1" ||
  String(process.env.COUNTERPOINT_SYNC_RELAXED ?? "").toLowerCase() === "true";

/** Effective SQL after optional auto-schema + maximal preset (rebuilt after SQL connect in sync mode). */
let effectiveSql = {};
/** When true, POST `/api/sync/counterpoint/staging` with `{ entity, payload }` (from ROS health). */
let rosStagingEnabled = false;
let bridgeHostnameCached = "";

function initEffectiveSqlFromConstants() {
  effectiveSql = {
    customers: CP_CUSTOMERS_QUERY,
    inventory: CP_INVENTORY_QUERY,
    catalog: CP_CATALOG_QUERY,
    catalog_cells: CP_CATALOG_CELLS_QUERY,
    category_masters: CP_CATEGORY_MASTERS_QUERY,
    tickets: CP_TICKETS_QUERY,
    ticket_lines: CP_TICKET_LINES_QUERY,
    ticket_payments: CP_TICKET_PAYMENTS_QUERY,
    ticket_cells: CP_TICKET_CELLS_QUERY,
    ticket_gift: CP_TICKET_GIFT_QUERY,
    gift_cards: CP_GIFT_CARDS_QUERY,
    gft_hist: CP_GFT_CERT_HIST_QUERY,
    loyalty: CP_LOYALTY_HIST_QUERY,
    vend_item: CP_VEND_ITEM_QUERY,
    vendors_filtered: CP_VENDORS_QUERY,
    customer_notes: CP_CUSTOMER_NOTES_QUERY,
    users: CP_USERS_QUERY,
    sales_reps: CP_SALES_REPS_QUERY,
    buyers: CP_BUYERS_QUERY,
    store_credit: CP_STORE_CREDIT_QUERY,
    open_docs: CP_OPEN_DOCS_QUERY,
    open_doc_lines: CP_OPEN_DOC_LINES_QUERY,
    open_doc_pmt: CP_OPEN_DOC_PMT_QUERY,
    receiving_history: CP_RECEIVING_HISTORY_QUERY,
    ticket_notes: CP_TICKET_NOTES_QUERY,
    vendors_fast_simple: CP_VENDORS_FAST_QUERY || CP_VENDORS_QUERY_SIMPLE,
  };
}
initEffectiveSqlFromConstants();

/** Full customer list (no ticket/note filter). */
const SQL_MAX_CUSTOMERS = `SELECT RTRIM(LTRIM(CAST(c.CUST_NO AS NVARCHAR(64)))) AS cust_no, RTRIM(LTRIM(c.FST_NAM)) AS first_name, RTRIM(LTRIM(c.LST_NAM)) AS last_name, RTRIM(LTRIM(c.NAM)) AS full_name, RTRIM(LTRIM(c.EMAIL_ADRS_1)) AS email, RTRIM(LTRIM(c.PHONE_1)) AS phone, RTRIM(LTRIM(c.ADRS_1)) AS address_line1, RTRIM(LTRIM(c.ADRS_2)) AS address_line2, RTRIM(LTRIM(c.CITY)) AS city, RTRIM(LTRIM(c.STATE)) AS state, RTRIM(LTRIM(c.ZIP_COD)) AS postal_code, RTRIM(LTRIM(c.CUST_TYP)) AS cust_typ, c.LOY_PTS_BAL AS pts_bal, RTRIM(LTRIM(c.SLS_REP)) AS sls_rep FROM AR_CUST c ORDER BY c.CUST_NO`;

function sqlMaxCatalog(costCol) {
  return `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS item_no, RTRIM(LTRIM(i.DESCR)) AS descr, i.LONG_DESCR AS long_descr, RTRIM(LTRIM(i.CATEG_COD)) AS categ_cod, RTRIM(LTRIM(i.VEND_NO)) AS vend_no, CASE WHEN EXISTS (SELECT 1 FROM IM_INV_CELL g WHERE g.ITEM_NO = i.ITEM_NO) THEN 'Y' ELSE 'N' END AS is_grd, p.PRC_1 AS prc_1, p.PRC_2 AS prc_2, p.PRC_3 AS prc_3, inv.${costCol} AS lst_cost, b.BARCOD AS barcode FROM IM_ITEM i LEFT JOIN IM_PRC p ON p.ITEM_NO = i.ITEM_NO LEFT JOIN IM_INV inv ON inv.ITEM_NO = i.ITEM_NO AND inv.LOC_ID = 'MAIN' LEFT JOIN IM_BARCOD b ON b.ITEM_NO = i.ITEM_NO WHERE RTRIM(LTRIM(i.ITEM_NO)) <> N'' ORDER BY i.ITEM_NO`;
}

function sqlMaxInventory(costCol) {
  return `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS sku, CAST(i.QTY_ON_HND AS INT) AS stock_on_hand, RTRIM(LTRIM(i.ITEM_NO)) AS counterpoint_item_key, i.${costCol} AS last_cost FROM IM_INV i WHERE i.ITEM_NO IS NOT NULL AND i.LOC_ID = 'MAIN'`;
}

const SQL_MAX_VEND_ITEM = `SELECT RTRIM(LTRIM(vi.VEND_NO)) AS vend_no, RTRIM(LTRIM(vi.ITEM_NO)) AS item_no, RTRIM(LTRIM(vi.VEND_ITEM_NO)) AS vend_item_no, vi.UNIT_COST AS vend_cost FROM PO_VEND_ITEM vi ORDER BY vi.VEND_NO, vi.ITEM_NO`;

const SQL_MAX_CATEGORY_MASTERS = `SELECT DISTINCT RTRIM(LTRIM(i.CATEG_COD)) AS cp_category, RTRIM(LTRIM(i.CATEG_COD)) AS display_name FROM IM_ITEM i WHERE RTRIM(LTRIM(i.ITEM_NO)) <> N'' AND NULLIF(RTRIM(LTRIM(i.CATEG_COD)), N'') IS NOT NULL ORDER BY cp_category`;

/** Primary stock location for maximal catalog + inventory templates (many CP DBs are not `MAIN`). */
function sqlLocId() {
  const raw = (process.env.CP_CATALOG_INV_LOC_ID ?? process.env.CP_INVENTORY_LOC_ID ?? "MAIN").trim();
  return raw || "MAIN";
}

function escapeSqlStringLiteral(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * `CP_IMPORT_SCOPE=maximal` parent catalog row — still not "all columns everywhere"; this builder reads
 * INFORMATION_SCHEMA so missing LONG_DESCR, IM_PRC, or IM_BARCOD/BARCOD names do not hard-fail the query.
 */
function buildFlexMaxCatalogSql(invCostCol, locId, entries) {
  const locEsc = escapeSqlStringLiteral(locId);
  const imItem = entries ? columnSet(entries, "IM_ITEM") : null;
  const imInv = entries ? columnSet(entries, "IM_INV") : null;
  const imPrc = entries ? columnSet(entries, "IM_PRC") : null;
  const imBar = entries ? columnSet(entries, "IM_BARCOD") : null;
  const imCell = entries ? columnSet(entries, "IM_INV_CELL") : null;

  const longExpr = imItem?.has("LONG_DESCR") ? "i.LONG_DESCR" : "CAST(NULL AS NVARCHAR(MAX))";
  const descrExpr = imItem?.has("DESCR") ? "RTRIM(LTRIM(i.DESCR))" : "CAST(NULL AS NVARCHAR(255))";
  const categExpr = imItem?.has("CATEG_COD")
    ? "RTRIM(LTRIM(i.CATEG_COD))"
    : "CAST(NULL AS NVARCHAR(64))";
  const vendExpr = "RTRIM(LTRIM(i.VEND_NO))";
  const gridExpr = imCell
    ? "CASE WHEN EXISTS (SELECT 1 FROM IM_INV_CELL g WHERE g.ITEM_NO = i.ITEM_NO) THEN 'Y' ELSE 'N' END"
    : "N'N'";

  const prcJoin = imPrc ? "LEFT JOIN IM_PRC p ON p.ITEM_NO = i.ITEM_NO" : "";
  const prc1 = imPrc?.has("PRC_1") ? "p.PRC_1" : "CAST(NULL AS DECIMAL(18,4))";
  const prc2 = imPrc?.has("PRC_2") ? "p.PRC_2" : "CAST(NULL AS DECIMAL(18,4))";
  const prc3 = imPrc?.has("PRC_3") ? "p.PRC_3" : "CAST(NULL AS DECIMAL(18,4))";

  const invJoin = imInv
    ? `LEFT JOIN IM_INV inv ON inv.ITEM_NO = i.ITEM_NO AND inv.LOC_ID = N'${locEsc}'`
    : "";
  let costField = invCostCol;
  if (imInv && !imInv.has(invCostCol)) {
    costField = imInv.has("LST_COST")
      ? "LST_COST"
      : imInv.has("AVG_COST")
        ? "AVG_COST"
        : imInv.has("LAST_COST")
          ? "LAST_COST"
          : null;
  }
  const invCostSql =
    imInv && costField ? `inv.${costField}` : "CAST(NULL AS DECIMAL(18,4))";

  let barcodeSelect;
  let barcodeJoin = "";
  if (imBar?.has("BARCOD")) {
    barcodeSelect = "b.BARCOD AS barcode";
    barcodeJoin = "LEFT JOIN IM_BARCOD b ON b.ITEM_NO = i.ITEM_NO";
  } else if (imBar?.has("BARCODE")) {
    barcodeSelect = "b.BARCODE AS barcode";
    barcodeJoin = "LEFT JOIN IM_BARCOD b ON b.ITEM_NO = i.ITEM_NO";
  } else {
    barcodeSelect = "CAST(NULL AS NVARCHAR(64)) AS barcode";
  }

  const tail = [prcJoin, invJoin, barcodeJoin].filter(Boolean).join(" ");
  return `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS item_no, ${descrExpr} AS descr, ${longExpr} AS long_descr, ${categExpr} AS categ_cod, ${vendExpr} AS vend_no, ${gridExpr} AS is_grd, ${prc1} AS prc_1, ${prc2} AS prc_2, ${prc3} AS prc_3, ${invCostSql} AS lst_cost, ${barcodeSelect} FROM IM_ITEM i ${tail} WHERE RTRIM(LTRIM(i.ITEM_NO)) <> N'' ORDER BY i.ITEM_NO`.replace(
    /\s+/g,
    " ",
  );
}

function buildFlexMaxInventorySql(invCostCol, locId, entries) {
  const locEsc = escapeSqlStringLiteral(locId);
  const imInv = entries ? columnSet(entries, "IM_INV") : null;
  let costField = invCostCol;
  if (imInv && !imInv.has(invCostCol)) {
    costField = imInv.has("LST_COST") ? "LST_COST" : imInv.has("AVG_COST") ? "AVG_COST" : imInv.has("LAST_COST") ? "LAST_COST" : "LST_COST";
  }
  return `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS sku, CAST(i.QTY_ON_HND AS INT) AS stock_on_hand, RTRIM(LTRIM(i.ITEM_NO)) AS counterpoint_item_key, i.${costField} AS last_cost FROM IM_INV i WHERE i.ITEM_NO IS NOT NULL AND i.LOC_ID = N'${locEsc}'`;
}

async function loadSchemaEntries(pool) {
  const inList = DISCOVER_TABLES.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ");
  const sqlText = `
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME IN (${inList})
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  `;
  const result = await pool.request().query(sqlText);
  return collectSchemaEntries(result.recordset);
}

async function rebuildEffectiveSql(pool) {
  initEffectiveSqlFromConstants();
  const scope = (process.env.CP_IMPORT_SCOPE ?? "default").trim().toLowerCase();
  const autoOn = (process.env.CP_AUTO_SCHEMA ?? "1").trim() !== "0";
  let invCost = "LST_COST";
  let imVendCol = "";
  let forcePoVendItem = false;
  let vendorFastOverride = "";

  let schemaEntries = null;
  if (autoOn || scope === "maximal") {
    try {
      schemaEntries = await loadSchemaEntries(pool);
    } catch (e) {
      console.warn("[schema] INFORMATION_SCHEMA probe failed:", e?.message ?? e);
    }
  }

  if (autoOn && schemaEntries) {
    const entries = schemaEntries;
    const imInv = columnSet(entries, "IM_INV");
    if (imInv) {
      for (const c of ["LST_COST", "AVG_COST", "LAST_COST"]) {
        if (imInv.has(c)) {
          invCost = c;
          break;
        }
      }
    }
    const imItem = columnSet(entries, "IM_ITEM");
    const vendCandidates = [
      "VEND_NO",
      "PUR_VND",
      "VND_NO",
      "PRIMARY_VND",
      "VND_ID",
      "PREFERRED_VND",
      "PRIM_VND",
      "USUAL_VND",
      "STK_VND",
      "ORD_VND",
      "DEF_VND",
      "VNDR_NO",
    ];
    let vcol = vendCandidates.find((c) => imItem?.has(c));
    if (!vcol && imItem) {
      const vendLike = [...imItem].filter((c) => typeof c === "string" && /VND|VEND/.test(c)).sort();
      if (vendLike.length === 1) vcol = vendLike[0];
    }
    if (vcol && vcol !== "VEND_NO" && !process.env.CP_IM_ITEM_VENDOR_COLUMN?.trim()) {
      imVendCol = vcol;
    }
    if (imItem && !vcol && columnSet(entries, "PO_VEND_ITEM")) {
      forcePoVendItem = !process.env.CP_IM_ITEM_VENDOR_SOURCE?.trim();
    }

    const poVend = columnSet(entries, "PO_VEND");
    if (poVend) {
      const nameCol = poVend.has("NAM")
        ? "NAM"
        : ["NAME", "DESCR", "VEND_NAM"].find((c) => poVend.has(c));
      const terms = poVend.has("TERMS_COD") ? "TERMS_COD" : null;
      if (nameCol) {
        vendorFastOverride = terms
          ? `SELECT RTRIM(LTRIM(VEND_NO)) AS vend_no, RTRIM(LTRIM(${nameCol})) AS name, RTRIM(LTRIM(${terms})) AS payment_terms FROM PO_VEND WHERE VEND_NO IS NOT NULL ORDER BY VEND_NO`
          : `SELECT RTRIM(LTRIM(VEND_NO)) AS vend_no, RTRIM(LTRIM(${nameCol})) AS name, CAST(NULL AS NVARCHAR(64)) AS payment_terms FROM PO_VEND WHERE VEND_NO IS NOT NULL ORDER BY VEND_NO`;
      }
    }

    const bits = [`IM_INV cost=${invCost}`];
    if (imVendCol) bits.push(`IM_ITEM vendor=${imVendCol}`);
    if (forcePoVendItem) bits.push("PO_VEND_ITEM vendor link");
    if (vendorFastOverride) bits.push("PO_VEND columns auto");
    console.info("[auto-schema]", bits.join("; "));
  }

  const locId = sqlLocId();

  {
    const envQ = (process.env.CP_CUSTOMERS_QUERY ?? "").trim();
    let src = envQ;
    if (!src && scope === "maximal") {
      src = SQL_MAX_CUSTOMERS;
    }
    if (src) {
      let q = applyCounterpointSqlCompat(expandImportSince(src));
      q = injectStoreCreditCustomerExistsClause(
        q,
        SYNC_STORE_CREDIT_OPENING,
        expandImportSince(CP_CUSTOMER_STORE_CREDIT_EXISTS_RAW),
      );
      effectiveSql.customers = q;
    }
  }

  {
    const envQ = (process.env.CP_INVENTORY_QUERY ?? "").trim();
    let src = envQ;
    if (!src && scope === "maximal") {
      src = schemaEntries
        ? buildFlexMaxInventorySql(invCost, locId, schemaEntries)
        : sqlMaxInventory("LST_COST");
      console.info(
        "[maximal] inventory SQL LOC_ID=" + locId + (schemaEntries ? " (schema-flex)" : " (static fallback)"),
      );
    }
    if (src) {
      effectiveSql.inventory = applyCounterpointSqlCompat(expandImportSince(src));
    }
  }

  {
    const envQ = (process.env.CP_CATALOG_QUERY ?? "").trim();
    let src = envQ;
    if (!src && scope === "maximal") {
      src = schemaEntries
        ? buildFlexMaxCatalogSql(invCost, locId, schemaEntries)
        : sqlMaxCatalog("LST_COST");
      console.info(
        "[maximal] parent catalog SQL LOC_ID=" + locId + (schemaEntries ? " (schema-flex)" : " (static fallback)"),
      );
    }
    if (src) {
      effectiveSql.catalog = applyCounterpointSqlCompat(expandImportSince(src));
    }
  }

  {
    const envQ = (process.env.CP_VEND_ITEM_QUERY ?? "").trim();
    let src = envQ;
    if (!src && scope === "maximal") src = SQL_MAX_VEND_ITEM;
    if (src) {
      effectiveSql.vend_item = expandImportSince(src);
    }
  }

  {
    const envQ = (process.env.CP_CATEGORY_MASTERS_QUERY ?? "").trim();
    let src = envQ;
    if (!src && scope === "maximal") src = SQL_MAX_CATEGORY_MASTERS;
    if (src) {
      effectiveSql.category_masters = expandImportSince(src);
    }
  }

  const prevCol = process.env.CP_IM_ITEM_VENDOR_COLUMN;
  const prevPo = process.env.CP_IM_ITEM_VENDOR_SOURCE;
  try {
    if (imVendCol) process.env.CP_IM_ITEM_VENDOR_COLUMN = imVendCol;
    if (forcePoVendItem) process.env.CP_IM_ITEM_VENDOR_SOURCE = "po_vend_item";

    if (effectiveSql.catalog?.trim()) {
      effectiveSql.catalog = pipeImItemVendorSql(effectiveSql.catalog);
    }
    if (effectiveSql.vend_item?.trim()) {
      effectiveSql.vend_item = applyCounterpointSqlCompat(applyImItemVendorColumn(effectiveSql.vend_item));
    }
  } finally {
    if (prevCol === undefined) delete process.env.CP_IM_ITEM_VENDOR_COLUMN;
    else process.env.CP_IM_ITEM_VENDOR_COLUMN = prevCol;
    if (prevPo === undefined) delete process.env.CP_IM_ITEM_VENDOR_SOURCE;
    else process.env.CP_IM_ITEM_VENDOR_SOURCE = prevPo;
  }

  if (invCost !== "LST_COST") {
    for (const k of ["inventory", "catalog", "catalog_cells", "vend_item"]) {
      if (effectiveSql[k]) {
        effectiveSql[k] = String(effectiveSql[k]).replace(/\bLST_COST\b/g, invCost);
      }
    }
  }

  if (vendorFastOverride && !(process.env.CP_VENDORS_FAST_QUERY ?? "").trim()) {
    effectiveSql.vendors_fast_simple = applyCounterpointSqlCompat(
      pipeImItemVendorSql(expandImportSince(vendorFastOverride)),
    );
  }

  // ── Auto-schema fixups for missing columns ────────────────────────────────
  if (autoOn && schemaEntries) {
    const imInvCell = columnSet(schemaEntries, "IM_INV_CELL");
    const psTktHistLin = columnSet(schemaEntries, "PS_TKT_HIST_LIN");
    const psTktHistLinCell = columnSet(schemaEntries, "PS_TKT_HIST_LIN_CELL");
    const psTktHistCell = columnSet(schemaEntries, "PS_TKT_HIST_CELL");
    const fixBits = [];

    // Catalog cells: detect actual DIM column names on IM_INV_CELL
    if (imInvCell) {
      for (const [dimN, dimRef] of [["DIM_1_VAL", "c.DIM_1_VAL"], ["DIM_2_VAL", "c.DIM_2_VAL"], ["DIM_3_VAL", "c.DIM_3_VAL"]]) {
        if (!imInvCell.has(dimN) && effectiveSql.catalog_cells.includes(dimRef)) {
          const alt = [dimN.replace("_VAL", "_UPR"), dimN.replace("_VAL", ""), dimN.replace("_", "").replace("_VAL", ""), `GRID_${dimN.match(/\d/)[0]}_VAL`].find((c) => imInvCell.has(c));
          if (alt) {
            effectiveSql.catalog_cells = String(effectiveSql.catalog_cells).replace(new RegExp(`\\bc\\.${dimN}\\b`, "gi"), `c.${alt}`);
            fixBits.push(`IM_INV_CELL: ${dimN} → ${alt}`);
          } else {
            effectiveSql.catalog_cells = String(effectiveSql.catalog_cells)
              .replace(new RegExp(`ISNULL\\s*\\(\\s*RTRIM\\s*\\(\\s*LTRIM\\s*\\(\\s*CONVERT\\s*\\(\\s*NVARCHAR\\s*\\(\\s*80\\s*\\)\\s*,\\s*c\\.${dimN}\\s*\\)\\s*\\)\\s*\\)\\s*,\\s*N''\\s*\\)`, "gi"), "N''")
              .replace(new RegExp(`c\\.${dimN}\\s+IS\\s+NOT\\s+NULL\\s+THEN\\s+N'\\s*\\/\\s*'\\s*\\+\\s*RTRIM\\s*\\(\\s*LTRIM\\s*\\(\\s*CONVERT\\s*\\(\\s*NVARCHAR\\s*\\(\\s*80\\s*\\)\\s*,\\s*c\\.${dimN}\\s*\\)\\s*\\)\\s*\\)\\s+ELSE\\s+N''`, "gi"), "1=0 THEN N'' ELSE N''");
            fixBits.push(`IM_INV_CELL: removed ${dimN}`);
          }
        }
      }
    }

    // Ticket lines: ITEM_DESCR missing on many CP builds
    if (psTktHistLin && !psTktHistLin.has("ITEM_DESCR") && effectiveSql.ticket_lines?.includes("ITEM_DESCR")) {
      effectiveSql.ticket_lines = String(effectiveSql.ticket_lines)
        .replace(/RTRIM\s*\(\s*LTRIM\s*\(\s*ITEM_DESCR\s*\)\s*\)\s+AS\s+description/gi, "CAST(NULL AS NVARCHAR(255)) AS description")
        .replace(/\bITEM_DESCR\b\s+AS\s+description/gi, "CAST(NULL AS NVARCHAR(255)) AS description");
      fixBits.push("PS_TKT_HIST_LIN: replaced ITEM_DESCR → NULL");
    }

    // Ticket cells: DIM_3_VAL missing
    const tktCellSet = psTktHistLinCell ?? psTktHistCell;
    if (tktCellSet && !tktCellSet.has("DIM_3_VAL") && effectiveSql.ticket_cells?.includes("DIM_3_VAL")) {
      effectiveSql.ticket_cells = String(effectiveSql.ticket_cells)
        .replace(/,?\s*DIM_3_VAL\s+AS\s+dim_3_val/gi, ", CAST(NULL AS NVARCHAR(80)) AS dim_3_val");
      fixBits.push("PS_TKT_HIST_*_CELL: replaced DIM_3_VAL → NULL");
    }

    if (fixBits.length > 0) {
      console.info("[auto-schema] column fixups:", fixBits.join("; "));
    }
  }
}

function logCanonicalSyncOrder() {
  console.info(
    "[sync-order] Enforced pass order: staff → sales_rep_stubs (opt) → vendors → customers → store_credit_opening (opt) → customer_notes (opt) → category_masters (opt, before catalog) → catalog → inventory → vendor_items (opt) → gift_cards (opt) → tickets/opt → open_docs (opt) → loyalty_hist (opt) → receiving_history (opt) → ticket_notes (opt).",
  );
}

/** Validates SYNC_* flags + required SQL for enabled entities; exits unless relaxed mode. */
function validateCounterpointSyncDependencyPlan() {
  const errors = [];
  const warnings = [];

  const anyEnabled =
    SYNC_STAFF ||
    SYNC_VENDORS ||
    SYNC_CUSTOMERS ||
    SYNC_STORE_CREDIT_OPENING ||
    SYNC_CUSTOMER_NOTES ||
    SYNC_CATEGORY_MASTERS ||
    SYNC_CATALOG ||
    SYNC_INVENTORY ||
    SYNC_VENDOR_ITEMS ||
    SYNC_GIFT_CARDS ||
    SYNC_TICKETS ||
    SYNC_OPEN_DOCS ||
    SYNC_LOYALTY_HIST;

  if (!anyEnabled) {
    warnings.push("All entity SYNC_* flags are off — this pass will only send heartbeat idle/syncing.");
  }

  if (SYNC_STORE_CREDIT_OPENING && !SYNC_CUSTOMERS) {
    errors.push("SYNC_STORE_CREDIT_OPENING=1 requires SYNC_CUSTOMERS=1 (rows key off customer_code).");
  }
  if (SYNC_CUSTOMER_NOTES && !SYNC_CUSTOMERS) {
    errors.push("SYNC_CUSTOMER_NOTES=1 requires SYNC_CUSTOMERS=1 (notes attach by cust_no).");
  }
  if (SYNC_INVENTORY && !SYNC_CATALOG) {
    errors.push("SYNC_INVENTORY=1 requires SYNC_CATALOG=1 (ROS variants must exist before stock updates).");
  }
  if (SYNC_VENDOR_ITEMS && (!SYNC_VENDORS || !SYNC_CATALOG)) {
    errors.push("SYNC_VENDOR_ITEMS=1 requires SYNC_VENDORS=1 and SYNC_CATALOG=1.");
  }
  if (SYNC_TICKETS && !SYNC_CUSTOMERS) {
    errors.push("SYNC_TICKETS=1 requires SYNC_CUSTOMERS=1.");
  }
  if (SYNC_TICKETS && !SYNC_CATALOG) {
    errors.push("SYNC_TICKETS=1 requires SYNC_CATALOG=1 (ticket lines resolve SKUs / counterpoint_item_key).");
  }
  if (SYNC_OPEN_DOCS && !SYNC_CUSTOMERS) {
    errors.push("SYNC_OPEN_DOCS=1 requires SYNC_CUSTOMERS=1.");
  }
  if (SYNC_OPEN_DOCS && !SYNC_CATALOG) {
    errors.push("SYNC_OPEN_DOCS=1 requires SYNC_CATALOG=1 (document lines need variants).");
  }
  if (SYNC_LOYALTY_HIST && !SYNC_CUSTOMERS) {
    errors.push("SYNC_LOYALTY_HIST=1 requires SYNC_CUSTOMERS=1.");
  }

  if (SYNC_STORE_CREDIT_OPENING && !CP_STORE_CREDIT_QUERY.trim()) {
    errors.push("SYNC_STORE_CREDIT_OPENING=1 requires a non-empty CP_STORE_CREDIT_QUERY.");
  }
  if (SYNC_STORE_CREDIT_OPENING && !CP_CUSTOMER_STORE_CREDIT_EXISTS_RAW.trim()) {
    warnings.push(
      "SYNC_STORE_CREDIT_OPENING=1: set CP_CUSTOMER_STORE_CREDIT_EXISTS (EXISTS body: SELECT 1 … matching c.CUST_NO with balance > 0) or customers with only store credit are skipped by CP_CUSTOMERS_QUERY.",
    );
  }
  if (SYNC_OPEN_DOCS && !String(effectiveSql.open_docs ?? "").trim()) {
    errors.push("SYNC_OPEN_DOCS=1 requires a non-empty CP_OPEN_DOCS_QUERY.");
  }
  if (SYNC_TICKETS && !String(effectiveSql.tickets ?? "").trim()) {
    errors.push("SYNC_TICKETS=1 requires a non-empty CP_TICKETS_QUERY.");
  }
  if (SYNC_CATEGORY_MASTERS && !String(effectiveSql.category_masters ?? "").trim()) {
    errors.push("SYNC_CATEGORY_MASTERS=1 requires a non-empty CP_CATEGORY_MASTERS_QUERY (set SYNC_CATEGORY_MASTERS=0 to skip).");
  }
  if (SYNC_CATALOG && !String(effectiveSql.catalog ?? "").trim()) {
    errors.push("SYNC_CATALOG=1 requires a non-empty CP_CATALOG_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_CUSTOMERS && !String(effectiveSql.customers ?? "").trim()) {
    errors.push("SYNC_CUSTOMERS=1 requires a non-empty CP_CUSTOMERS_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_VENDORS && SYNC_VENDORS_FILTERED && !String(effectiveSql.vendors_filtered ?? "").trim()) {
    errors.push("SYNC_VENDORS_FILTERED=1 requires a non-empty CP_VENDORS_QUERY.");
  }
  if (SYNC_INVENTORY && !String(effectiveSql.inventory ?? "").trim()) {
    errors.push("SYNC_INVENTORY=1 requires a non-empty CP_INVENTORY_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_VENDOR_ITEMS && !String(effectiveSql.vend_item ?? "").trim()) {
    errors.push("SYNC_VENDOR_ITEMS=1 requires a non-empty CP_VEND_ITEM_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_CUSTOMER_NOTES && !String(effectiveSql.customer_notes ?? "").trim()) {
    errors.push("SYNC_CUSTOMER_NOTES=1 requires a non-empty CP_CUSTOMER_NOTES_QUERY.");
  }
  if (SYNC_LOYALTY_HIST && !String(effectiveSql.loyalty ?? "").trim()) {
    errors.push("SYNC_LOYALTY_HIST=1 requires a non-empty CP_LOYALTY_HIST_QUERY.");
  }
  if (SYNC_GIFT_CARDS && !String(effectiveSql.gift_cards ?? "").trim()) {
    errors.push("SYNC_GIFT_CARDS=1 requires a non-empty CP_GIFT_CARDS_QUERY.");
  }

  if (
    SYNC_STAFF &&
    !String(effectiveSql.users ?? "").trim() &&
    !String(effectiveSql.sales_reps ?? "").trim() &&
    !String(effectiveSql.buyers ?? "").trim()
  ) {
    errors.push(
      "SYNC_STAFF=1 requires at least one non-empty query among CP_USERS_QUERY, CP_SALES_REPS_QUERY, CP_BUYERS_QUERY.",
    );
  }

  if (SYNC_CATALOG && !SYNC_VENDORS) {
    warnings.push(
      "SYNC_CATALOG=1 with SYNC_VENDORS=0: IM_ITEM VEND_NO may not resolve to vendors until vendors are synced.",
    );
  }
  if (!SYNC_STAFF && (SYNC_CUSTOMERS || SYNC_TICKETS || SYNC_OPEN_DOCS)) {
    warnings.push(
      "SYNC_STAFF=0: preferred_salesperson_id / processed_by will not resolve (no staff or sales-rep stub sync).",
    );
  }

  for (const w of warnings) {
    console.warn("[sync-plan]", w);
  }

  if (errors.length === 0) {
    return;
  }

  if (SYNC_RELAXED_DEPENDENCIES) {
    console.warn(
      "[sync-plan] SYNC_RELAXED_DEPENDENCIES=1 — continuing despite dependency/SQL issues (expert mode):",
    );
    for (const e of errors) {
      console.warn("  -", e);
    }
    return;
  }

  console.error(
    "[sync-plan] Fix .env or set SYNC_RELAXED_DEPENDENCIES=1 for incremental expert runs (see comment in .env.example).",
  );
  for (const e of errors) {
    console.error("  -", e);
  }
  process.exit(1);
}

/** Tables the bridge cares about (INFORMATION_SCHEMA probe). */
const DISCOVER_TABLES = [
  "IM_INV",
  "IM_ITEM",
  "IM_INV_CELL",
  "IM_PRC",
  "IM_BARCOD",
  "AR_CUST",
  "AR_CUST_NOTE",
  "SY_USR",
  "PS_SLS_REP",
  "PO_BUYER",
  "PO_VEND",
  "PO_VEND_ITEM",
  "IM_CATEG",
  "IM_SUBCAT",
  "PS_TKT_HIST",
  "PS_TKT_HIST_LIN",
  "PS_TKT_HIST_PMT",
  "PS_TKT_HIST_CELL",
  "PS_TKT_HIST_LIN_CELL",
  "PS_TKT_HIST_GFT",
  "SY_GFT_CERT",
  "SY_GFT_CERT_HIST",
  "PS_LOY_PTS_HIST",
  "PS_DOC",
  "PS_DOC_LIN",
  "PS_DOC_PMT",
];

function waitForEnterBeforeClose() {
  if (!WAIT_AFTER_RUN_ONCE) return Promise.resolve();
  if (!process.stdin.isTTY) {
    console.info("(stdin is not a TTY — skipping wait; use START_BRIDGE.cmd or set WAIT_AFTER_RUN_ONCE=0)");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\n=== Sync pass finished (success or partial). Press Enter to close this window ===\n", () => {
      rl.close();
      resolve();
    });
  });
}

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

async function rosFetch(urlPath, body, method = "POST", extraHeaders = {}) {
  const url = `${ROS_BASE_URL}${urlPath}`;
  const headers = {
    "Content-Type": "application/json",
    "x-ros-sync-token": SYNC_TOKEN,
    ...extraHeaders,
  };
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ROS_FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body != null ? JSON.stringify(body) : undefined,
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(ROS_FETCH_TIMEOUT_MS, 60000));
  try {
    const res = await fetch(url, { headers: { "x-ros-sync-token": SYNC_TOKEN }, signal: ac.signal });
    if (!res.ok) throw new Error(`health ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Startup: fails if health unreachable. */
async function refreshRosStagingFromHealth() {
  const h = await rosGetHealth();
  rosStagingEnabled = h.counterpoint_staging_enabled === true;
  return h;
}

async function refreshRosStagingFromHealthSilent() {
  try {
    const h = await rosGetHealth();
    rosStagingEnabled = h.counterpoint_staging_enabled === true;
  } catch {
    rosStagingEnabled = false;
  }
}

/** Maps `staging.entity` / heartbeat `current_entity` keys to REST path segment (when not staging). */
const ENTITY_HTTP_PATH = {
  customers: "customers",
  inventory: "inventory",
  category_masters: "category-masters",
  catalog: "catalog",
  gift_cards: "gift-cards",
  tickets: "tickets",
  vendors: "vendors",
  vendor_items: "vendor-items",
  customer_notes: "customer-notes",
  loyalty_hist: "loyalty-hist",
  staff: "staff",
  sales_rep_stubs: "sales-rep-stubs",
  store_credit_opening: "store-credit-opening",
  open_docs: "open-docs",
  receiving_history: "receiving-history",
};

function bridgeIngestHeaders() {
  return {
    "x-bridge-version": BRIDGE_VERSION,
    "x-bridge-hostname": bridgeHostnameCached || "unknown",
  };
}

/** ROS returned 400 because Settings turned staging off after our last health poll — fall back to direct ingest. */
function rosRejectedStagingDisabled(err) {
  return /staging is disabled/i.test(String(err?.message ?? err ?? ""));
}

async function rosPost(entityKey, body) {
  const pathSeg = ENTITY_HTTP_PATH[entityKey];
  if (!pathSeg) {
    throw new Error(`rosPost: unknown entity ${entityKey}`);
  }
  const hdr = bridgeIngestHeaders();
  const directUrl = `/api/sync/counterpoint/${pathSeg}`;
  if (rosStagingEnabled) {
    try {
      return await rosFetch(
        "/api/sync/counterpoint/staging",
        { entity: entityKey, payload: body },
        "POST",
        hdr,
      );
    } catch (e) {
      if (rosRejectedStagingDisabled(e)) {
        console.warn(
          "[ingest] ROS staging was disabled in Back Office (or health was stale). Retrying this batch via direct import.",
        );
        rosStagingEnabled = false;
        return await rosFetch(directUrl, body, "POST", hdr);
      }
      throw e;
    }
  }
  return await rosFetch(directUrl, body, "POST", hdr);
}

async function sendHeartbeat(phase, currentEntity) {
  try {
    const resp = await rosFetch("/api/sync/counterpoint/heartbeat", {
      phase,
      current_entity: currentEntity ?? null,
      version: BRIDGE_VERSION,
      hostname: (await import("node:os")).hostname(),
    });
    return resp;
  } catch (e) {
    console.error("[heartbeat]", e.message ?? e);
    return null;
  }
}

/** Same matrix key convention as IM_INV_CELL / catalog (parent|dim1|dim2|dim3). */
function cpMatrixItemKey(parentItemNo, d1, d2, d3) {
  const p = String(parentItemNo ?? "").trim();
  if (!p) return undefined;
  const norm = (v) => {
    if (v == null || v === "") return "";
    return String(v).trim();
  };
  return `${p}|${norm(d1)}|${norm(d2)}|${norm(d3)}`;
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

async function syncReceivingHistory(pool) {
  if (!String(effectiveSql.receiving_history ?? "").trim()) {
    console.warn("[receiving_history] CP_RECEIVING_HISTORY_QUERY empty; skip");
    return;
  }
  try {
    const result = await pool.request().query(effectiveSql.receiving_history);
    const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
    if (rows.length === 0) {
      console.info("[receiving_history] no rows");
      return;
    }

    const RECV_BATCH = 50;
    const CONCURRENCY = 5;
    const pendingRequests = [];
    
    console.info(`[receiving_history] sending ${rows.length} rows (batch=${RECV_BATCH}, parallel=${CONCURRENCY})...`);

    for (let i = 0; i < rows.length; i += RECV_BATCH) {
      const chunk = rows.slice(i, i + RECV_BATCH).map((r) => ({
        vend_no: String(r.vend_no ?? "").trim(),
        item_no: String(r.item_no ?? "").trim(),
        recv_dat: r.recv_dat != null ? String(new Date(r.recv_dat).toISOString()) : "",
        unit_cost: Number(r.unit_cost ?? 0),
        qty_recv: Number(r.qty_recv ?? 0),
        po_no: r.po_no != null ? String(r.po_no).trim() : undefined,
        recv_no: r.recv_no != null ? String(r.recv_no).trim() : undefined,
      }));

      const lastDat = rows[Math.min(i + RECV_BATCH - 1, rows.length - 1)].recv_dat;
      const body = {
        rows: chunk,
        sync: { entity: "receiving_history", cursor: lastDat },
      };

      const promise = rosPost("receiving_history", body)
        .then((summary) => {
          console.info("[receiving_history] batch", summary);
        })
        .catch((err) => {
          console.error("[receiving_history] batch failed:", err.message);
        })
        .finally(() => {
          pendingRequests.splice(pendingRequests.indexOf(promise), 1);
        });

      pendingRequests.push(promise);
      if (pendingRequests.length >= CONCURRENCY) {
        await Promise.race(pendingRequests);
      }
    }
    await Promise.all(pendingRequests);
  } catch (err) {
    console.error("[receiving_history] sync failed:", err?.message ?? err);
  }
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapCustomerRow(r) {
  return {
    cust_no: String(r.cust_no ?? "").trim(),
    first_name: r.first_name ?? r.fst_nam ?? undefined,
    last_name: r.last_name ?? r.lst_nam ?? undefined,
    full_name: r.full_name ?? r.nam ?? undefined,
    company_name: r.company_name ?? undefined,
    email: r.email ?? r.email_adrs_1 ?? r.email_adrs ?? undefined,
    phone: r.phone ?? r.phone_1 ?? undefined,
    address_line1: r.address_line1 ?? r.adrs_1 ?? undefined,
    address_line2: r.address_line2 ?? r.adrs_2 ?? undefined,
    city: r.city ?? undefined,
    state: r.state ?? undefined,
    postal_code: r.postal_code ?? r.zip_cod ?? undefined,
    date_of_birth: r.date_of_birth ?? undefined,
    marketing_email_opt_in: r.marketing_email_opt_in ?? undefined,
    marketing_sms_opt_in: r.marketing_sms_opt_in ?? undefined,
    loyalty_points: r.loyalty_points ?? (r.pts_bal != null ? Number(r.pts_bal) : undefined),
    customer_type: r.customer_type ?? r.cust_typ ?? undefined,
    ar_balance: r.ar_balance ?? (r.bal != null ? String(r.bal) : undefined),
    sls_rep: r.sls_rep ?? undefined,
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
        : r.last_cost != null
          ? String(r.last_cost)
          : r.lst_cost != null
            ? String(r.lst_cost)
            : undefined,
  };
}

function mapCatalogRow(r, cellRows) {
  const itemNo = String(r.item_no ?? "").trim();
  
  // Filter out redundant "dummy" or "parent-only" variations that lack real dimension data
  const validCells = (cellRows ?? []).filter(c => {
    const sku = String(c.sku ?? "").trim();
    const label = String(c.variation_label ?? "").trim();
    // A valid variation must have a non-empty SKU and a label that isn't just whitespace or " / / "
    if (!sku || sku === itemNo) return false;
    if (!label || label === "/" || label === " / " || label === " / / ") return false;
    return true;
  });

  const isGrid = String(r.is_grid ?? r.is_grd ?? "N").toUpperCase() === "Y" || validCells.length > 0;
  
  return {
    item_no: itemNo,
    description: r.description ?? r.descr ?? undefined,
    long_description: r.long_description ?? r.long_descr ?? undefined,
    brand: r.brand ?? undefined,
    category: r.category ?? r.categ_cod ?? undefined,
    vendor_no: r.vendor_no ?? r.vend_no ?? undefined,
    retail_price: r.retail_price != null ? String(r.retail_price) : (r.prc_1 != null ? String(r.prc_1) : undefined),
    prc_2: r.prc_2 != null ? String(r.prc_2) : undefined,
    prc_3: r.prc_3 != null ? String(r.prc_3) : undefined,
    unit_cost:
      r.unit_cost != null
        ? String(r.unit_cost)
        : r.lst_cost != null
          ? String(r.lst_cost)
          : r.last_cost != null
            ? String(r.last_cost)
            : undefined,
    is_grid: isGrid,
    barcode: r.barcode ?? undefined,
    cells: validCells.map((c) => ({
      counterpoint_item_key: String(c.counterpoint_item_key ?? c.cell_descr ?? "").trim(),
      sku: String(c.sku ?? "").trim(),
      barcode: c.barcode ?? undefined,
      variation_label: String(c.variation_label ?? c.descr ?? "").trim(),
      stock_on_hand: c.stock_on_hand != null ? Number(c.stock_on_hand) : undefined,
      reorder_point: c.reorder_point ?? (c.min_qty != null ? Number(c.min_qty) : undefined),
      retail_price: c.retail_price != null ? String(c.retail_price) : undefined,
      prc_2: c.prc_2 != null ? String(c.prc_2) : undefined,
      prc_3: c.prc_3 != null ? String(c.prc_3) : undefined,
      unit_cost:
        c.unit_cost != null
          ? String(c.unit_cost)
          : c.lst_cost != null
            ? String(c.lst_cost)
            : c.last_cost != null
              ? String(c.last_cost)
              : undefined,
    })),
  };
}

function mapGiftCardRow(r, histRows) {
  const issueDat = r.issue_dat ?? r.issued_at;
  return {
    cert_no: String(r.cert_no ?? r.gft_cert_no ?? "").trim(),
    balance: String(r.balance ?? r.bal ?? r.bal_amt ?? "0"),
    original_value: r.original_value ?? (r.orig_amt != null ? String(r.orig_amt) : undefined),
    reason_cod: r.reason_cod ?? undefined,
    expires_at: r.expires_at ?? undefined,
    issued_at: issueDat ? new Date(issueDat).toISOString() : undefined,
    events: (histRows ?? []).map((h) => ({
      event_kind: String(h.action ?? h.event_kind ?? "adjustment").toLowerCase(),
      amount: String(h.amt ?? h.amount ?? "0"),
      balance_after: h.balance_after != null ? String(h.balance_after) : undefined,
      notes: h.tkt_no ? `Ticket ${h.tkt_no}` : undefined,
      created_at: h.trx_dat ?? h.created_at ?? undefined,
    })),
  };
}

function mapTicketRow(r) {
  return {
    ticket_ref: String(r.ticket_ref ?? r.tkt_no ?? "").trim(),
    cust_no: r.cust_no ? String(r.cust_no).trim() : undefined,
    booked_at: r.booked_at ?? r.bus_dat ?? undefined,
    total_price: String(r.total_price ?? r.tkt_tot ?? "0"),
    amount_paid: String(r.amount_paid ?? r.amt_paid ?? "0"),
    usr_id: r.usr_id ? String(r.usr_id).trim() : undefined,
    sls_rep: r.sls_rep ? String(r.sls_rep).trim() : undefined,
    lines: [],
    payments: [],
    gift_applications: [],
  };
}

function mapTicketLineRow(r) {
  return {
    sku: r.sku ? String(r.sku).trim() : undefined,
    counterpoint_item_key: r.counterpoint_item_key ? String(r.counterpoint_item_key).trim() : undefined,
    lin_seq_no: r.lin_seq_no != null ? Number(r.lin_seq_no) : r.lin_seq != null ? Number(r.lin_seq) : undefined,
    quantity: Number(r.quantity ?? r.qty ?? r.qty_sold ?? 1),
    unit_price: String(r.unit_price ?? r.prc ?? "0"),
    unit_cost: r.unit_cost != null ? String(r.unit_cost) : undefined,
    description: r.description ?? r.descr ?? undefined,
    reason_code: r.reason_code ?? r.reas_cod ?? undefined,
  };
}

function mapTicketPaymentRow(r) {
  return {
    pmt_typ: String(r.pmt_typ ?? r.pay_cod ?? "CASH").trim(),
    amount: String(r.amount ?? r.pmt_amt ?? "0"),
    gift_cert_no: r.gift_cert_no ?? undefined,
  };
}

/** PS_DOC header → ROS `open-docs` payload row (align column aliases in CP_OPEN_DOCS_QUERY with SSMS). */
function mapOpenDocRow(r) {
  return {
    doc_ref: String(r.doc_ref ?? r.doc_id ?? "").trim(),
    cust_no: r.cust_no ? String(r.cust_no).trim() : undefined,
    booked_at: r.booked_at ?? r.doc_dat ?? r.bus_dat ?? undefined,
    total_price: String(r.total_price ?? r.tot ?? "0"),
    amount_paid: String(r.amount_paid ?? r.amt_paid ?? "0"),
    usr_id: r.usr_id ? String(r.usr_id).trim() : undefined,
    sls_rep: r.sls_rep ? String(r.sls_rep).trim() : undefined,
    cp_status:
      r.cp_status != null
        ? String(r.cp_status).trim()
        : r.sta_cod != null
          ? String(r.sta_cod).trim()
          : r.doc_sta != null
            ? String(r.doc_sta).trim()
            : undefined,
    doc_typ: r.doc_typ ? String(r.doc_typ).trim() : undefined,
    lines: [],
    payments: [],
  };
}

// ── Sync entity functions ────────────────────────────────────────────────────

async function syncCustomers(pool) {
  if (!String(effectiveSql.customers ?? "").trim()) {
    console.warn("[customers] CP_CUSTOMERS_QUERY empty; skip");
    return;
  }
  const state = readState();
  const result = await pool.request().query(effectiveSql.customers);
  const rows = result.recordset ?? [];
  if (rows.length === 0) {
    console.info("[customers] no rows");
    return;
  }

  const CUSTOMER_BATCH = Math.max(1, Number.parseInt(process.env.BATCH_SIZE ?? "200", 10));
  const MAX_CONCURRENCY = 5;
  console.info("[customers] SQL returned", rows.length, "row(s); sending with parallel-concurrency=5");
  
  const mapped = rows.map((row) => mapCustomerRow(normalizeRowKeys(row))).filter((r) => r.cust_no);
  const pendingRequests = [];
  let inFlight = 0;

  for (let i = 0; i < mapped.length; i += CUSTOMER_BATCH) {
    const chunk = mapped.slice(i, i + CUSTOMER_BATCH);
    const last = chunk[chunk.length - 1]?.cust_no;
    const body = {
      rows: chunk,
      sync: { entity: "customers", cursor: last },
    };

    const promise = rosPost("customers", body)
      .then((summary) => {
        console.info("[customers] batch", summary);
        if (last) {
          state.customers_cursor = last;
          writeState(state);
        }
      })
      .catch((err) => {
        console.error("[customers] batch failed:", err.message);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= MAX_CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncInventory(pool) {
  if (!String(effectiveSql.inventory ?? "").trim()) {
    console.warn("[inventory] CP_INVENTORY_QUERY empty; skip");
    return;
  }
  const state = readState();
  const result = await pool.request().query(effectiveSql.inventory);
  const rows = result.recordset ?? [];
  const mapped = rows.map((row) => mapInventoryRow(normalizeRowKeys(row))).filter((r) => r.sku);
  
  const INV_BATCH = 50; 
  const MAX_CONCURRENCY = 5;
  const pendingRequests = [];
  let inFlight = 0;

  console.info(`[inventory] processing ${mapped.length} rows (batch=${INV_BATCH}, parallel=${MAX_CONCURRENCY})...`);

  for (let i = 0; i < mapped.length; i += INV_BATCH) {
    const chunk = mapped.slice(i, i + INV_BATCH);
    const body = {
      rows: chunk,
      sync: { entity: "inventory", cursor: String(i + chunk.length) },
    };

    const promise = rosPost("inventory", body)
      .then((summary) => {
        console.info("[inventory] batch", summary);
        state.inventory_cursor = String(i + chunk.length);
        writeState(state);
      })
      .catch((err) => {
        console.error("[inventory] batch failed:", err.message);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= MAX_CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

function mapCategoryMasterRow(r) {
  return {
    cp_category: String(r.cp_category ?? "").trim(),
    display_name: r.display_name ?? r.descr ?? undefined,
  };
}

async function syncCategoryMasters(pool) {
  if (!String(effectiveSql.category_masters ?? "").trim()) {
    console.warn("[category_masters] CP_CATEGORY_MASTERS_QUERY empty; skip");
    return;
  }
  const result = await pool.request().query(effectiveSql.category_masters);
  const rows = (result.recordset ?? []).map((r) => mapCategoryMasterRow(normalizeRowKeys(r))).filter((x) => x.cp_category);
  if (rows.length === 0) {
    console.info("[category_masters] no rows");
    return;
  }
  console.info("[category_masters] SQL returned", rows.length, "row(s); sending in batches of", BATCH);
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.cp_category;
    const body = {
      rows: chunk,
      sync: { entity: "category_masters", cursor: last },
    };
    const summary = await rosPost("category_masters", body);
    console.info("[category_masters] batch", summary);
  }
}

async function syncCatalog(pool) {
  if (!String(effectiveSql.catalog ?? "").trim()) {
    console.warn("[catalog] CP_CATALOG_QUERY empty; skip");
    return;
  }

  // Load cells first (usually small enough to buffer in safe chunks)
  let cellLookup = {};
  if (String(effectiveSql.catalog_cells ?? "").trim()) {
    try {
      console.info("[catalog] Fetching matrix variations...");
      const cellResult = await pool.request().query(effectiveSql.catalog_cells);
      const seenCells = new Set();
      for (const cr of cellResult.recordset ?? []) {
        const nr = normalizeRowKeys(cr);
        const parentKey = String(nr.parent_item_no ?? nr.item_no ?? "").trim();
        const ckey = String(nr.counterpoint_item_key ?? nr.sku ?? "").trim();
        const dedupeKey = `${parentKey}|${ckey}`;
        
        if (!cellKeyIsValid(nr) || seenCells.has(dedupeKey)) continue;
        seenCells.add(dedupeKey);
        
        if (!cellLookup[parentKey]) cellLookup[parentKey] = [];
        cellLookup[parentKey].push(nr);
      }
      console.info(`[catalog] Buffered ${Object.keys(cellLookup).length} matrix parents.`);
    } catch (cellErr) {
      console.error("[catalog] IM_INV_CELL query failed:", cellErr?.message ?? cellErr);
      cellLookup = {};
    }
  }

  /**
   * Helper to check if a cell record is non-empty logic-wise.
   */
  function cellKeyIsValid(nr) {
    const key = String(nr.counterpoint_item_key ?? nr.sku ?? "").trim();
    if (!key) return false;
    // Skip records where the key is just the parent item no (redundant)
    if (key === String(nr.parent_item_no ?? "").trim()) return false;
    return true;
  }

  const CATALOG_BATCH_SIZE = 50; // High-speed batch size for v8.2
  const MAX_CONCURRENCY = 5; // Parallel processing limit
  console.info(`[catalog] Starting Hyper-Speed ingest (batch=${CATALOG_BATCH_SIZE}, parallel=${MAX_CONCURRENCY})...`);
  
  const state = readState();
  const processedItemNos = new Set(); // SPU (Squelcher): tracks parents to avoid multiplication loops
  let batchBuffer = [];
  let totalProcessed = 0;
  let skippedDuplicates = 0;
  let inFlight = 0;
  const pendingRequests = [];

  return new Promise((resolve, reject) => {
    const request = pool.request();
    request.stream = true;
    request.query(effectiveSql.catalog);

    request.on("row", (row) => {
      const normalized = normalizeRowKeys(row);
      const itemNo = String(normalized.item_no ?? "").trim();

      // DUPLICATE SQUELCHER: 
      // If we've already seen this itemNo in THE SAME PASS, skip it.
      if (!itemNo || processedItemNos.has(itemNo)) {
        if (itemNo) skippedDuplicates++;
        return;
      }
      processedItemNos.add(itemNo);

      const mapped = mapCatalogRow(normalized, cellLookup[itemNo] ?? []);
      
      if (mapped.item_no) {
        batchBuffer.push(mapped);
        if (batchBuffer.length >= CATALOG_BATCH_SIZE) {
          const chunk = [...batchBuffer];
          batchBuffer = [];
          
          const last = chunk[chunk.length - 1].item_no;
          const promise = rosPost("catalog", { rows: chunk, sync: { entity: "catalog", cursor: last } })
            .then((summary) => {
              totalProcessed += chunk.length;
              console.info(`[catalog] processed ${totalProcessed} items (skipped ${skippedDuplicates} duplicates)...`, summary);
              if (last) {
                state.catalog_cursor = last;
                writeState(state);
              }
              inFlight--;
              if (inFlight < MAX_CONCURRENCY) request.resume();
            })
            .catch((err) => {
              console.error("[catalog] batch failed:", err.message);
              inFlight--;
              request.resume();
            });

          pendingRequests.push(promise);
          inFlight++;
          if (inFlight >= MAX_CONCURRENCY) {
            request.pause();
          }
        }
      }
    });

    request.on("error", (err) => {
      console.error("[catalog] stream error:", err.message);
      reject(err);
    });

    request.on("done", async () => {
      try {
        if (batchBuffer.length > 0) {
          const last = batchBuffer[batchBuffer.length - 1].item_no;
          pendingRequests.push(rosPost("catalog", { rows: batchBuffer, sync: { entity: "catalog", cursor: last } }));
          totalProcessed += batchBuffer.length;
          if (last) {
            state.catalog_cursor = last;
            writeState(state);
          }
        }
        
        await Promise.all(pendingRequests);
        console.info(`[catalog] finished. ${totalProcessed} total items synced (${skippedDuplicates} duplicates filtered).`);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function syncGiftCards(pool) {
  if (!String(effectiveSql.gift_cards ?? "").trim()) {
    console.warn("[gift_cards] CP_GIFT_CARDS_QUERY empty; skip");
    return;
  }
  const result = await pool.request().query(effectiveSql.gift_cards);
  const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (rows.length === 0) {
    console.info("[gift_cards] no rows");
    return;
  }

  let histLookup = {};
  if (String(effectiveSql.gft_hist ?? "").trim()) {
    const histResult = await pool.request().query(effectiveSql.gft_hist);
    for (const hr of histResult.recordset ?? []) {
      const nr = normalizeRowKeys(hr);
      const certNo = String(nr.gft_cert_no ?? nr.cert_no ?? "").trim();
      if (!histLookup[certNo]) histLookup[certNo] = [];
      histLookup[certNo].push(nr);
    }
  }

  const mapped = rows
    .map((r) => {
      const certNo = String(r.cert_no ?? r.gft_cert_no ?? "").trim();
      return mapGiftCardRow(r, histLookup[certNo] ?? []);
    })
    .filter((r) => r.cert_no);

  const CONCURRENCY = 5;
  const pendingRequests = [];
  let inFlight = 0;
  console.info("[gift_cards] SQL returned", mapped.length, "card(s); sending with parallel-concurrency=5");

  const state = readState();
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.cert_no;
    const body = {
      rows: chunk,
      sync: { entity: "gift_cards", cursor: last },
    };

    const promise = rosPost("gift_cards", body)
      .then((summary) => {
        console.info("[gift_cards] batch", summary);
        if (last) {
          state.gift_cards_cursor = last;
          writeState(state);
        }
      })
      .catch((err) => {
        console.error("[gift_cards] batch failed:", err.message);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncTickets(pool) {
  if (!String(effectiveSql.tickets ?? "").trim()) {
    console.warn("[tickets] CP_TICKETS_QUERY empty; skip");
    return;
  }

  const headerResult = await pool.request().query(effectiveSql.tickets);
  const headerRows = (headerResult.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (headerRows.length === 0) {
    console.info("[tickets] no rows");
    return;
  }

  let lineLookup = {};
  if (String(effectiveSql.ticket_lines ?? "").trim()) {
    try {
      const lineResult = await pool.request().query(effectiveSql.ticket_lines);
      for (const lr of lineResult.recordset ?? []) {
        const nr = normalizeRowKeys(lr);
        const ref = String(nr.ticket_ref ?? nr.tkt_no ?? "").trim();
        if (!lineLookup[ref]) lineLookup[ref] = [];
        lineLookup[ref].push(nr);
      }
    } catch (lineErr) {
      console.error("[tickets] PS_TKT_HIST_LIN query failed (tickets will import WITHOUT line items):", lineErr?.message ?? lineErr);
      console.warn("[tickets] Run DISCOVER_SCHEMA.cmd to see actual PS_TKT_HIST_LIN columns, then fix CP_TICKET_LINES_QUERY in .env");
      lineLookup = {};
    }
  }

  let pmtLookup = {};
  if (String(effectiveSql.ticket_payments ?? "").trim()) {
    const pmtResult = await pool.request().query(effectiveSql.ticket_payments);
    for (const pr of pmtResult.recordset ?? []) {
      const nr = normalizeRowKeys(pr);
      const ref = String(nr.ticket_ref ?? nr.tkt_no ?? "").trim();
      if (!pmtLookup[ref]) pmtLookup[ref] = [];
      pmtLookup[ref].push(nr);
    }
  }

  const cellByTicketLine = {};
  if (String(effectiveSql.ticket_cells ?? "").trim()) {
    try {
      const cellResult = await pool.request().query(effectiveSql.ticket_cells);
      for (const row of cellResult.recordset ?? []) {
        const nr = normalizeRowKeys(row);
        const tkt = String(nr.tkt_no ?? nr.ticket_ref ?? "").trim();
        const seq = nr.lin_seq_no != null ? Number(nr.lin_seq_no) : NaN;
        if (!tkt || Number.isNaN(seq)) continue;
        cellByTicketLine[`${tkt}|${seq}`] = nr;
      }
    } catch (cellErr) {
      console.error("[tickets] ticket cell query failed:", cellErr?.message ?? cellErr);
    }
  }

  const giftLookup = {};
  if (String(effectiveSql.ticket_gift ?? "").trim()) {
    const giftResult = await pool.request().query(effectiveSql.ticket_gift);
    for (const row of giftResult.recordset ?? []) {
      const nr = normalizeRowKeys(row);
      const ref = String(nr.tkt_no ?? nr.ticket_ref ?? "").trim();
      if (!ref) continue;
      giftLookup[ref].push(nr);
    }
  }

  let noteLookup = {};
  if (SYNC_TICKET_NOTES && String(effectiveSql.ticket_notes ?? "").trim()) {
    try {
      const noteResult = await pool.request().query(effectiveSql.ticket_notes);
      for (const row of noteResult.recordset ?? []) {
        const nr = normalizeRowKeys(row);
        // Robust fallback: your v8.2 might use DOC_ID or TKT_NO or TKT_REF
        const ref = String(nr.ticket_ref ?? nr.tkt_no ?? nr.doc_id ?? nr.doc_ref ?? "").trim();
        if (!ref) continue;
        if (!noteLookup[ref]) noteLookup[ref] = [];
        noteLookup[ref].push(nr.note ?? nr.note_txt ?? nr.note_text ?? "");
      }
    } catch (noteErr) {
      console.warn("[tickets] note lookup failed (skipping notes for this pass):", noteErr?.message ?? noteErr);
      noteLookup = {};
    }
  }

  const mapped = headerRows.map((r) => {
    const tkt = mapTicketRow(r);
    const ref = tkt.ticket_ref;
    tkt.notes = (noteLookup[ref] ?? []).join("\n").trim() || undefined;
    tkt.lines = (lineLookup[ref] ?? []).map((lr) => {
      const nr = normalizeRowKeys(lr);
      const seq = nr.lin_seq_no != null ? Number(nr.lin_seq_no) : nr.lin_seq != null ? Number(nr.lin_seq) : NaN;
      const itemNoRaw = nr.sku ?? nr.item_no;
      const itemNo = itemNoRaw != null ? String(itemNoRaw).trim() : "";
      const cell = !Number.isNaN(seq) ? cellByTicketLine[`${ref}|${seq}`] : undefined;
      let ckey =
        nr.counterpoint_item_key != null && String(nr.counterpoint_item_key).trim() !== ""
          ? String(nr.counterpoint_item_key).trim()
          : undefined;
      if (cell && itemNo) {
        const mk = cpMatrixItemKey(itemNo, cell.dim_1_val, cell.dim_2_val, cell.dim_3_val);
        if (mk) ckey = mk;
      }
      return mapTicketLineRow({
        ...nr,
        sku: itemNo || undefined,
        counterpoint_item_key: ckey,
      });
    });
    tkt.payments = (pmtLookup[ref] ?? []).map(mapTicketPaymentRow);
    tkt.gift_applications = (giftLookup[ref] ?? [])
      .map((g) => {
        const gr = normalizeRowKeys(g);
        return {
          gift_cert_no: String(gr.gft_cert_no ?? gr.gift_cert_no ?? "").trim(),
          amount: String(gr.amt ?? gr.amount ?? "0"),
          action: gr.action != null ? String(gr.action).trim() : undefined,
        };
      })
      .filter((x) => x.gift_cert_no);
    return tkt;
  }).filter((r) => r.ticket_ref);

  console.info("[tickets] Processing mapped headers (parallel-concurrency=5)...");
  const state = readState();
  const CONCURRENCY = 5;
  const pendingRequests = [];
  let inFlight = 0;

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.ticket_ref;
    const body = {
      rows: chunk,
      sync: { entity: "tickets", cursor: last },
    };

    const promise = rosPost("tickets", body)
      .then((summary) => {
        console.info("[tickets] batch", summary);
        if (last) {
          state.tickets_cursor = last;
          writeState(state);
        }
      })
      .catch((err) => {
        console.error("[tickets] batch failed:", err.message);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncStoreCreditOpening(pool) {
  if (!String(effectiveSql.store_credit ?? "").trim()) {
    console.warn("[store_credit_opening] CP_STORE_CREDIT_QUERY empty; skip");
    return;
  }

  const result = await pool.request().query(effectiveSql.store_credit);
  const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (rows.length === 0) {
    console.info("[store_credit_opening] no rows");
    return;
  }

  const mapped = rows
    .map((r) => ({
      cust_no: String(r.cust_no ?? "").trim(),
      balance: String(r.balance ?? r.bal ?? r.sc_bal ?? "0"),
    }))
    .filter((r) => r.cust_no);

  if (mapped.length === 0) {
    console.info("[store_credit_opening] no valid rows");
    return;
  }

  console.info("[store_credit_opening] Sending opening balances (parallel-concurrency=5)...");
  const state = readState();
  const CONCURRENCY = 5;
  const pendingRequests = [];
  let inFlight = 0;

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.cust_no;
    const body = {
      rows: chunk,
      sync: { entity: "store_credit_opening", cursor: last ?? String(i + chunk.length) },
    };

    const promise = rosPost("store_credit_opening", body)
      .then((summary) => {
        console.info("[store_credit_opening] batch", summary);
        if (last) {
          state.store_credit_opening_cursor = last;
          writeState(state);
        }
      })
      .catch((err) => {
        console.error("[store_credit_opening] batch failed:", err.message);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncOpenDocs(pool) {
  if (!String(effectiveSql.open_docs ?? "").trim()) {
    console.warn("[open_docs] CP_OPEN_DOCS_QUERY empty; skip");
    return;
  }

  const headerResult = await pool.request().query(effectiveSql.open_docs);
  const headerRows = (headerResult.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (headerRows.length === 0) {
    console.info("[open_docs] no rows");
    return;
  }

  let lineLookup = {};
  if (String(effectiveSql.open_doc_lines ?? "").trim()) {
    const lineResult = await pool.request().query(effectiveSql.open_doc_lines);
    for (const lr of lineResult.recordset ?? []) {
      const nr = normalizeRowKeys(lr);
      const ref = String(nr.doc_ref ?? nr.doc_id ?? "").trim();
      if (!ref) continue;
      if (!lineLookup[ref]) lineLookup[ref] = [];
      lineLookup[ref].push(nr);
    }
  }

  let pmtLookup = {};
  if (String(effectiveSql.open_doc_pmt ?? "").trim()) {
    const pmtResult = await pool.request().query(effectiveSql.open_doc_pmt);
    for (const pr of pmtResult.recordset ?? []) {
      const nr = normalizeRowKeys(pr);
      const ref = String(nr.doc_ref ?? nr.doc_id ?? "").trim();
      if (!ref) continue;
      if (!pmtLookup[ref]) pmtLookup[ref] = [];
      pmtLookup[ref].push(nr);
    }
  }

  const mapped = headerRows
    .map((r) => {
      const doc = mapOpenDocRow(r);
      const ref = doc.doc_ref;
      doc.lines = (lineLookup[ref] ?? []).map((lr) => {
        const nr = normalizeRowKeys(lr);
        const itemNoRaw = nr.sku ?? nr.item_no;
        const itemNo = itemNoRaw != null ? String(itemNoRaw).trim() : "";
        return mapTicketLineRow({
          ...nr,
          sku: itemNo || undefined,
          counterpoint_item_key:
            nr.counterpoint_item_key != null && String(nr.counterpoint_item_key).trim() !== ""
              ? String(nr.counterpoint_item_key).trim()
              : itemNo || undefined,
        });
      });
      doc.payments = (pmtLookup[ref] ?? []).map(mapTicketPaymentRow);
      return doc;
    })
    .filter((r) => r.doc_ref);

  console.info("[open_docs] Sending items (parallel-concurrency=5)...");
  const state = readState();
  const CONCURRENCY = 5;
  const pendingRequests = [];
  let inFlight = 0;

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.doc_ref;
    const body = {
      rows: chunk,
      sync: { entity: "open_docs", cursor: last },
    };

    const promise = rosPost("open_docs", body)
      .then((summary) => {
        console.info("[open_docs] batch", summary);
        if (last) {
          state.open_docs_cursor = last;
          writeState(state);
        }
      })
      .catch((err) => {
        console.error("[open_docs] batch failed:", err.message);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncLoyaltyHist(pool) {
  if (!String(effectiveSql.loyalty ?? "").trim()) {
    console.warn("[loyalty_hist] CP_LOYALTY_HIST_QUERY empty; skip");
    return;
  }
  const result = await pool.request().query(effectiveSql.loyalty);
  const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (rows.length === 0) {
    console.info("[loyalty_hist] no rows");
    return;
  }
  const mapped = rows
    .map((r) => {
      let busDat = r.bus_dat;
      if (busDat != null && typeof busDat === "object" && typeof busDat.toISOString === "function") {
        busDat = busDat.toISOString().slice(0, 10);
      } else if (busDat != null) {
        busDat = String(busDat).trim();
      }
      return {
        cust_no: String(r.cust_no ?? "").trim(),
        bus_dat: busDat || undefined,
        pts_earnd: r.pts_earnd != null ? Number(r.pts_earnd) : undefined,
        pts_redeemd: r.pts_redeemd != null ? Number(r.pts_redeemd) : undefined,
        ref_no: r.ref_no != null ? String(r.ref_no).trim() : undefined,
      };
    })
    .filter((r) => r.cust_no);

  if (mapped.length === 0) {
    console.info("[loyalty_hist] no valid rows");
    return;
  }

  console.info("[loyalty_hist] SQL returned", mapped.length, "row(s); sending with parallel-concurrency=5");

  const CONCURRENCY = 5;
  const pendingRequests = [];

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const body = {
      rows: chunk,
      sync: { entity: "loyalty_hist", cursor: String(i + chunk.length) },
    };
    
    const promise = rosPost("loyalty_hist", body)
      .then((summary) => {
        console.info("[loyalty_hist] batch", summary);
      })
      .catch((err) => {
        console.error("[loyalty_hist] batch failed:", err.message);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncVendorItems(pool) {
  if (!String(effectiveSql.vend_item ?? "").trim()) {
    console.warn("[vendor_items] CP_VEND_ITEM_QUERY empty; skip");
    return;
  }
  const result = await pool.request().query(effectiveSql.vend_item);
  const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (rows.length === 0) {
    console.info("[vendor_items] no rows");
    return;
  }
  const mapped = rows
    .map((r) => ({
      vend_no: String(r.vend_no ?? "").trim(),
      item_no: String(r.item_no ?? "").trim(),
      vend_item_no: r.vend_item_no != null ? String(r.vend_item_no).trim() : undefined,
      vend_cost: r.vend_cost != null ? String(r.vend_cost) : undefined,
    }))
    .filter((r) => r.vend_no && r.item_no);
    
  if (mapped.length === 0) {
    console.info("[vendor_items] no valid rows");
    return;
  }

  console.info("[vendor_items] SQL returned", mapped.length, "row(s); sending with parallel-concurrency=5");

  const CONCURRENCY = 5;
  const pendingRequests = [];
  const state = readState();

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const body = { rows: chunk, sync: { entity: "vendor_items", cursor: String(i + chunk.length) } };
    
    const promise = rosPost("vendor_items", body).then(summary => {
      console.info("[vendor_items] batch", summary);
      state.vendor_items_cursor = String(i + chunk.length);
      writeState(state);
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncVendors(pool) {
  const vendorsSql = SYNC_VENDORS_FILTERED
    ? String(effectiveSql.vendors_filtered ?? "").trim()
    : CP_VENDORS_FAST_QUERY || effectiveSql.vendors_fast_simple || CP_VENDORS_QUERY_SIMPLE;
  if (!vendorsSql) {
    console.warn("[vendors] no vendor SQL; skip");
    return;
  }
  if (!SYNC_VENDORS_FILTERED) {
    const src = CP_VENDORS_FAST_QUERY ? "CP_VENDORS_FAST_QUERY" : "built-in PO_VEND (NAM, TERMS_COD)";
    console.info(
      `[vendors] fast path (${src}). All PO_VEND rows — CP_VENDORS_QUERY is ignored unless SYNC_VENDORS_FILTERED=1.`,
    );
  } else {
    console.info("[vendors] filtered path: CP_VENDORS_QUERY (SYNC_VENDORS_FILTERED=1).");
  }
  const result = await pool.request().query(vendorsSql);
  const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (rows.length === 0) {
    console.info("[vendors] no rows");
    return;
  }
  const mapped = rows
    .map((r) => ({
      vend_no: String(r.vend_no ?? "").trim(),
      name: r.name ?? r.nam ?? undefined,
      email: r.email ?? undefined,
      phone: r.phone ?? r.phone_1 ?? undefined,
      account_number: r.account_number ?? undefined,
      payment_terms: r.payment_terms ?? r.terms_cod ?? undefined,
    }))
    .filter((r) => r.vend_no);

  console.info("[vendors] SQL returned", mapped.length, "vendor(s); sending with parallel-concurrency=5");

  const CONCURRENCY = 5;
  const pendingRequests = [];
  const state = readState();

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.vend_no;
    const body = { rows: chunk, sync: { entity: "vendors", cursor: last } };
    
    const promise = rosPost("vendors", body).then(summary => {
      console.info("[vendors] batch", summary);
      if (last) { state.vendors_cursor = last; writeState(state); }
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncCustomerNotes(pool) {
  if (!String(effectiveSql.customer_notes ?? "").trim()) {
    console.warn("[customer_notes] CP_CUSTOMER_NOTES_QUERY empty; skip");
    return;
  }
  const result = await pool.request().query(effectiveSql.customer_notes);
  const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
  if (rows.length === 0) {
    console.info("[customer_notes] no rows");
    return;
  }
  const mapped = rows
    .map((r) => ({
      cust_no: String(r.cust_no ?? "").trim(),
      note_id: String(r.note_id ?? r.note_seq_no ?? "").trim(),
      note_date: r.note_date ?? (r.note_dat ? (new Date(r.note_dat)).toISOString() : undefined),
      note_text: String(r.note_text ?? r.note_txt ?? "").trim(),
      user_id: r.user_id ?? r.usr_id ?? undefined,
    }))
    .filter((r) => r.cust_no && r.note_text);
    
  console.info("[customer_notes] SQL returned", mapped.length, "note(s); sending with parallel-concurrency=5");

  const CONCURRENCY = 5;
  const pendingRequests = [];
  const state = readState();

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const body = { rows: chunk, sync: { entity: "customer_notes", cursor: String(i + chunk.length) } };
    
    const promise = rosPost("customer_notes", body).then(summary => {
      console.info("[customer_notes] batch", summary);
      state.customer_notes_cursor = String(i + chunk.length);
      writeState(state);
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

async function syncStaff(pool) {
  const allRows = [];

  if (String(effectiveSql.users ?? "").trim()) {
    const result = await pool.request().query(effectiveSql.users);
    for (const row of result.recordset ?? []) {
      const r = normalizeRowKeys(row);
      const code = String(r.usr_id ?? "").trim();
      if (!code) continue;
      allRows.push({
        code,
        source: "user",
        name: r.nam ?? r.name ?? undefined,
        email: r.email_adrs ?? r.email ?? undefined,
        status: r.stat ?? r.status ?? undefined,
        user_group: r.usr_grp_id ?? r.user_group ?? undefined,
      });
    }
    console.info("[staff] SY_USR returned", allRows.length, "user(s)");
  }

  if (String(effectiveSql.sales_reps ?? "").trim()) {
    const result = await pool.request().query(effectiveSql.sales_reps);
    let count = 0;
    for (const row of result.recordset ?? []) {
      const r = normalizeRowKeys(row);
      const code = String(r.sls_rep ?? "").trim();
      if (!code) continue;
      const commPct = r.commis_pct != null ? String(r.commis_pct) : undefined;
      allRows.push({
        code,
        source: "sales_rep",
        name: r.nam ?? r.name ?? undefined,
        status: r.stat ?? r.status ?? undefined,
        commission_rate: commPct,
      });
      count++;
    }
    console.info("[staff] PS_SLS_REP returned", count, "rep(s)");
  }

  if (String(effectiveSql.buyers ?? "").trim()) {
    const result = await pool.request().query(effectiveSql.buyers);
    let count = 0;
    for (const row of result.recordset ?? []) {
      const r = normalizeRowKeys(row);
      const code = String(r.buyer_id ?? "").trim();
      if (!code) continue;
      allRows.push({
        code,
        source: "buyer",
        name: r.nam ?? r.name ?? undefined,
        status: "A",
      });
      count++;
    }
    console.info("[staff] PO_BUYER returned", count, "buyer(s)");
  }

  if (allRows.length === 0) {
    console.info("[staff] no staff rows to sync");
    return;
  }

  console.info("[staff] SQL returned", allRows.length, "total staff; sending with parallel-concurrency=5");

  const CONCURRENCY = 5;
  const pendingRequests = [];
  const state = readState();

  for (let i = 0; i < allRows.length; i += BATCH) {
    const chunk = allRows.slice(i, i + BATCH);
    const body = { rows: chunk, sync: { entity: "staff", cursor: String(i + chunk.length) } };
    
    const promise = rosPost("staff", body).then(summary => {
      console.info("[staff] batch", summary);
      state.staff_cursor = String(i + chunk.length);
      writeState(state);
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
}

/**
 * When `PS_SLS_REP` is not queried, create `counterpoint_staff_map` rows for distinct `SLS_REP` values
 * seen on AR_CUST and PS_TKT_HIST (server skips codes already mapped, e.g. SY_USR).
 */
async function syncSalesRepStubs(pool) {
  const sqlText = `
    SELECT DISTINCT x.code
    FROM (
      SELECT RTRIM(LTRIM(CAST(SLS_REP AS NVARCHAR(64)))) AS code FROM AR_CUST WHERE SLS_REP IS NOT NULL
      UNION
      SELECT RTRIM(LTRIM(CAST(SLS_REP AS NVARCHAR(64)))) AS code FROM PS_TKT_HIST WHERE SLS_REP IS NOT NULL
    ) x
    WHERE x.code IS NOT NULL AND LEN(x.code) > 0
    ORDER BY x.code
  `;
  const result = await pool.request().query(sqlText);
  const codes = [];
  const seen = new Set();
  for (const row of result.recordset ?? []) {
    const r = normalizeRowKeys(row);
    const c = String(r.code ?? "").trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    codes.push(c);
  }
  if (codes.length === 0) {
    console.info("[sales_rep_stubs] no distinct SLS_REP codes found");
    return;
  }
  console.info("[sales_rep_stubs] sending", codes.length, "distinct code(s) to /sales-rep-stubs");
  const summary = await rosPost("sales_rep_stubs", {
    codes,
    sync: { entity: "sales_rep_stubs", cursor: String(codes.length) },
  });
  console.info("[sales_rep_stubs] batch", summary);
}

function collectSchemaEntries(recordset) {
  const entries = [];
  const keyToIndex = new Map();
  for (const row of recordset ?? []) {
    const schema = String(row.TABLE_SCHEMA ?? "").trim();
    const table = String(row.TABLE_NAME ?? "").trim();
    const col = String(row.COLUMN_NAME ?? "").trim().toUpperCase();
    const key = `${schema}\0${table}`;
    let idx = keyToIndex.get(key);
    if (idx === undefined) {
      idx = entries.length;
      keyToIndex.set(key, idx);
      entries.push({ schema, table, columns: new Set() });
    }
    entries[idx].columns.add(col);
  }
  return entries;
}

/** Prefer dbo when the same table name appears in multiple schemas. */
function pickTableEntry(entries, tableUpper) {
  const want = tableUpper.toUpperCase();
  const matches = entries.filter((e) => e.table.toUpperCase() === want);
  if (matches.length === 0) return null;
  const dbo = matches.find((e) => e.schema.toLowerCase() === "dbo");
  return dbo ?? matches[0];
}

function columnSet(entries, tableName) {
  const e = pickTableEntry(entries, tableName);
  return e?.columns ?? null;
}

/** Report file: default next to script. Set CP_DISCOVER_OUTPUT to a path to override; CP_DISCOVER_OUTPUT=0 turns off. */
function discoverReportPath() {
  const raw = process.env.CP_DISCOVER_OUTPUT?.trim();
  if (raw && /^(0|false|no|off)$/i.test(raw)) return null;
  if (raw) return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return path.join(__dirname, "counterpoint-schema-report.txt");
}

/**
 * Queries INFORMATION_SCHEMA on the connected company database. Does not call Riverside OS.
 */
async function runDiscover(pool) {
  const entries = await loadSchemaEntries(pool);

  const lines = [];
  const emit = (line) => {
    lines.push(line);
    console.info(line);
  };

  const visible = new Set(entries.map((e) => e.table.toUpperCase()));
  const rawMissing = DISCOVER_TABLES.filter((t) => !visible.has(t));
  const ticketCellOk =
    visible.has("PS_TKT_HIST_CELL") || visible.has("PS_TKT_HIST_LIN_CELL");
  const missing = rawMissing.filter((t) => {
    if (ticketCellOk && (t === "PS_TKT_HIST_CELL" || t === "PS_TKT_HIST_LIN_CELL")) return false;
    return true;
  });

  const note = (msg) => emit(`       ${msg}`);
  const dline = (title, ok) => {
    const mark = ok ? "ok " : "—  ";
    emit(`  [${mark}] ${title}`);
  };

  emit("");
  emit("══════════════════════════════════════════════════════════════════════");
  emit("  Counterpoint schema probe (read-only — no Riverside sync)");
  emit(`  Bridge ${BRIDGE_VERSION}`);
  emit("══════════════════════════════════════════════════════════════════════");
  emit("");
  const matchedCount = DISCOVER_TABLES.length - rawMissing.length;
  emit(
    `  Tables matched in INFORMATION_SCHEMA: ${matchedCount} / ${DISCOVER_TABLES.length} names checked`,
  );
  if (missing.length) {
    emit("  Not visible to this login (wrong Database= in connection string, typo, or no rights):");
    emit(`    ${missing.join(", ")}`);
  }
  emit("");

  const imInv = columnSet(entries, "IM_INV");
  if (imInv) {
    const costOrder = ["LST_COST", "AVG_COST", "LAST_COST"];
    const found = costOrder.filter((c) => imInv.has(c));
    if (found.length === 0) {
      dline("IM_INV cost column", false);
      note("No LST_COST / AVG_COST / LAST_COST — open SSMS, pick a cost column, edit CP_INVENTORY_QUERY + catalog queries.");
    } else {
      const primary = found[0];
      const tpl = "LST_COST";
      dline("IM_INV cost column", primary === tpl);
      if (primary === tpl) {
        note(`Template already uses ${primary} — no change needed for inventory/catalog cost.`);
      } else {
        note(`Your DB uses ${primary}. Replace LST_COST with ${primary} in CP_INVENTORY_QUERY, CP_CATALOG_QUERY, CP_CATALOG_CELLS_QUERY (inv.LST_COST → inv.${primary}).`);
      }
    }
  }

  const imItem = columnSet(entries, "IM_ITEM");
  if (imItem) {
    const vendCandidates = [
      "VEND_NO",
      "PUR_VND",
      "VND_NO",
      "PRIMARY_VND",
      "VND_ID",
      "PREFERRED_VND",
      "PRIM_VND",
      "USUAL_VND",
      "STK_VND",
      "ORD_VND",
      "DEF_VND",
      "VNDR_NO",
    ];
    const vcolStatic = vendCandidates.find((c) => imItem.has(c));
    const vendLike = [...imItem].filter((c) => typeof c === "string" && /VND|VEND/.test(c)).sort();
    let vcol = vcolStatic;
    if (!vcol && vendLike.length === 1) vcol = vendLike[0];

    if (vcol === "VEND_NO") {
      dline("IM_ITEM vendor column", true);
      note("VEND_NO present — default template matches.");
    } else if (vcol) {
      dline("IM_ITEM vendor column", false);
      note(`Set CP_IM_ITEM_VENDOR_COLUMN=${vcol} in .env (template uses i.VEND_NO).`);
    } else {
      dline("IM_ITEM vendor column", false);
      if (vendLike.length > 1) {
        note(
          `Several columns match *VND*/*VEND*: ${vendLike.join(", ")} — set CP_IM_ITEM_VENDOR_COLUMN to the primary vendor code, or CP_IM_ITEM_VENDOR_SOURCE=po_vend_item.`,
        );
      } else {
        note(
          "No vendor column on IM_ITEM — add CP_IM_ITEM_VENDOR_SOURCE=po_vend_item to .env (uses PO_VEND_ITEM for catalog vend_no + vendor list).",
        );
      }
    }
    if (imItem.has("SUBCATEG_COD")) {
      dline("IM_ITEM SUBCATEG_COD", true);
      note("Optional: add subcategory to CP_CATEGORY_MASTERS_QUERY / CP_CATALOG_QUERY (see .env.example comments).");
    } else {
      dline("IM_ITEM SUBCATEG_COD", false);
      note("Absent — defaults use CATEG_COD only.");
    }
  }

  const poVend = columnSet(entries, "PO_VEND");
  if (poVend) {
    dline("PO_VEND VEND_NO", poVend.has("VEND_NO"));
    if (!poVend.has("VEND_NO")) {
      note("No VEND_NO on PO_VEND — vendor sync needs a custom CP_VENDORS_FAST_QUERY / CP_VENDORS_QUERY.");
    }
    const nameCol = poVend.has("NAM")
      ? "NAM"
      : ["NAME", "VEND_NAM", "DESCR"].find((c) => poVend.has(c));
    dline("PO_VEND name column (NAM)", !!nameCol);
    if (!nameCol) {
      note("No NAM/NAME-style column on PO_VEND — set CP_VENDORS_FAST_QUERY with correct AS name column.");
    } else if (nameCol !== "NAM") {
      note(`Use RTRIM(LTRIM(${nameCol})) AS name in CP_VENDORS_FAST_QUERY (template expects NAM).`);
    }
    dline("PO_VEND TERMS_COD", poVend.has("TERMS_COD"));
    if (!poVend.has("TERMS_COD")) {
      note(
        "TERMS_COD absent — vendor fast query will fail until you set CP_VENDORS_FAST_QUERY (e.g. CAST(NULL AS NVARCHAR(64)) AS payment_terms) or map the real terms column.",
      );
    }
  }

  const ar = columnSet(entries, "AR_CUST");
  if (ar) {
    const pts = ["PTS_BAL", "LOY_PTS", "LOY_PTS_BAL"].find((c) => ar.has(c));
    if (pts) {
      dline("AR_CUST points column", true);
      note(`Found ${pts} — use "${pts} AS pts_bal" in CP_CUSTOMERS_QUERY (replace CAST(NULL AS INT) AS pts_bal).`);
    } else {
      dline("AR_CUST points column", false);
      note("No PTS_BAL / LOY_PTS — keep CAST(NULL AS INT) AS pts_bal in CP_CUSTOMERS_QUERY.");
    }
  }

  const usr = columnSet(entries, "SY_USR");
  if (usr) {
    if (usr.has("USR_GRP_ID")) {
      dline("SY_USR USR_GRP_ID", true);
      note('Replace "CAST(NULL AS NVARCHAR(32)) AS usr_grp_id" with RTRIM(LTRIM(USR_GRP_ID)) AS usr_grp_id in CP_USERS_QUERY.');
    } else {
      dline("SY_USR USR_GRP_ID", false);
      note("Column absent — template NULL usr_grp_id is correct.");
    }
    if (!usr.has("EMAIL_ADRS")) {
      dline("SY_USR EMAIL_ADRS", false);
      note("Use CAST(NULL AS NVARCHAR(255)) AS email_adrs in CP_USERS_QUERY if sync fails on email column.");
    }
  }

  const rep = columnSet(entries, "PS_SLS_REP");
  if (rep?.has("COMMIS_METH")) {
    dline("PS_SLS_REP COMMIS_METH", true);
    note("Optional: RTRIM(LTRIM(COMMIS_METH)) AS commis_meth instead of NULL in CP_SALES_REPS_QUERY.");
  }

  const tkt = columnSet(entries, "PS_TKT_HIST");
  if (tkt) {
    if (tkt.has("TOT_AMT_DUE") && tkt.has("TOT_EXTD_PRC")) {
      dline("PS_TKT_HIST amount paid", true);
      note("Use (TOT_EXTD_PRC - TOT_AMT_DUE) AS amount_paid in CP_TICKETS_QUERY (replace duplicate TOT_EXTD_PRC AS amount_paid).");
    } else if (!tkt.has("TOT_AMT_DUE")) {
      dline("PS_TKT_HIST TOT_AMT_DUE", false);
      note("Absent — keep TOT_EXTD_PRC AS amount_paid (fully-paid assumption for closed tickets).");
    }
    if (!tkt.has("TOT_EXTD_PRC") && tkt.has("TOT")) {
      dline("PS_TKT_HIST totals", false);
      note("TOT_EXTD_PRC missing — try TOT AS total_price and TOT AS amount_paid in CP_TICKETS_QUERY.");
    }
    if (tkt.has("DOC_TYP")) {
      dline("PS_TKT_HIST DOC_TYP", true);
      note("Set CP_OMIT_PS_TKT_DOC_TYP_FILTER=0 to enforce closed-ticket DOC_TYP = T (bridge defaults to omitting when unset).");
    } else if (tkt.has("DOC_TYPE")) {
      dline("PS_TKT_HIST doc type", false);
      note("Column is DOC_TYPE — set CP_OMIT_PS_TKT_DOC_TYP_FILTER=0 and CP_TKT_DOC_TYP_COLUMN=DOC_TYPE for strict typing.");
    } else {
      dline("PS_TKT_HIST DOC_TYP", false);
      note("DOC_TYP / DOC_TYPE not in metadata — bridge omits doc-type filters by default.");
    }
  }

  const vendItem = columnSet(entries, "PO_VEND_ITEM");
  if (vendItem) {
    const costCandidates = ["VEND_COST", "UNIT_COST", "LST_COST", "COST", "PUR_COST"];
    const v = costCandidates.find((c) => vendItem.has(c));
    if (v) {
      dline("PO_VEND_ITEM vendor cost", true);
      note(`Use ${v} AS vend_cost in CP_VEND_ITEM_QUERY (replace CAST(NULL...) AS vend_cost).`);
    } else {
      dline("PO_VEND_ITEM vendor cost", false);
      note("No common cost column name — leave NULL or pick a column in SSMS.");
    }
  }

  const hasGftCert = pickTableEntry(entries, "SY_GFT_CERT");
  const hasGfc = pickTableEntry(entries, "SY_GFC");
  const giftTemplateOk = !!hasGftCert;
  dline("Gift cards (SY_GFT_CERT template)", giftTemplateOk);
  if (hasGfc && !hasGftCert) {
    note("This DB uses SY_GFC / SY_GFC_HIST — bridge default queries target SY_GFT_CERT; keep SYNC_GIFT_CARDS=0 unless CP_GIFT_CARDS_QUERY is rewritten for SY_GFC.");
  } else if (giftTemplateOk) {
    note("Set SYNC_GIFT_CARDS=1 in .env to import.");
  } else {
    note("No SY_GFT_CERT — keep SYNC_GIFT_CARDS=0.");
  }

  const hasLoyPs = pickTableEntry(entries, "PS_LOY_PTS_HIST");
  const hasLoyAr =
    pickTableEntry(entries, "AR_LOY_PT_ADJ_TRX") || pickTableEntry(entries, "AR_LOY_PT_ADJ_HIST");
  const loyTemplateOk = !!hasLoyPs;
  dline("Loyalty history (PS_LOY_PTS_HIST template)", loyTemplateOk);
  if (hasLoyAr && !hasLoyPs) {
    note("This DB uses AR_LOY_PT_ADJ_* — bridge default targets PS_LOY_PTS_HIST; keep SYNC_LOYALTY_HIST=0 unless CP_LOYALTY_HIST_QUERY is rewritten.");
  } else if (loyTemplateOk) {
    note("Set SYNC_LOYALTY_HIST=1 in .env to import.");
  } else {
    note("No PS_LOY_PTS_HIST — keep SYNC_LOYALTY_HIST=0.");
  }

  if (ticketCellOk) {
    dline("Ticket matrix cells (PS_TKT_HIST_*CELL)", true);
    if (visible.has("PS_TKT_HIST_LIN_CELL") && !visible.has("PS_TKT_HIST_CELL")) {
      note("Use PS_TKT_HIST_LIN_CELL in CP_TICKET_CELLS_QUERY (v8-style); PS_TKT_HIST_CELL is absent.");
    } else if (visible.has("PS_TKT_HIST_CELL")) {
      note("PS_TKT_HIST_CELL present — template column names apply when CP_TICKET_CELLS_QUERY is set.");
    }
  } else {
    dline("Ticket matrix cells (PS_TKT_HIST_*CELL)", false);
    note("Leave CP_TICKET_CELLS_QUERY empty; ticket lines use parent ITEM_NO for variant key.");
  }

  emit("");
  emit("  Edit .env as indicated, then run START_BRIDGE.cmd");
  emit("");

  const reportPath = discoverReportPath();
  if (reportPath) {
    try {
      fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
      emit(`Report saved: ${reportPath}`);
    } catch (e) {
      console.error("[discover] could not write report file:", e?.message ?? e);
    }
  }
}

async function waitForDiscoverClose() {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("\n=== Schema probe finished. Press Enter to close ===\n", () => {
      rl.close();
      resolve();
    });
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/** Isolate entity failures so one bad SQL query does not hide which entity failed. */
async function runSyncEntity(entityLabel, fn) {
  try {
    await fn();
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error(`[${entityLabel}] sync failed:`, msg);
  }
}

  }
}

/** Global pool reference for manual trigger hydration */
let ACTIVE_POOL = null;

function getOrderedSyncSteps(poolOverride) {
  const pool = poolOverride || ACTIVE_POOL;
  if (!pool) return [];
  return [
    { on: SYNC_STAFF, label: "staff", hb: "staff", run: () => syncStaff(pool) },
    {
      on: SYNC_SLS_REP_STUBS,
      label: "sales_rep_stubs",
      hb: "sales_rep_stubs",
      run: () => syncSalesRepStubs(pool),
    },
    { on: SYNC_VENDORS, label: "vendors", hb: "vendors", run: () => syncVendors(pool) },
    { on: SYNC_CUSTOMERS, label: "customers", hb: "customers", run: () => syncCustomers(pool) },
    {
      on: SYNC_STORE_CREDIT_OPENING,
      label: "store_credit_opening",
      hb: "store_credit_opening",
      run: () => syncStoreCreditOpening(pool),
    },
    { on: SYNC_CUSTOMER_NOTES, label: "customer_notes", hb: "customer_notes", run: () => syncCustomerNotes(pool) },
    {
      on: SYNC_CATEGORY_MASTERS,
      label: "category_masters",
      hb: "category_masters",
      run: () => syncCategoryMasters(pool),
    },
    { on: SYNC_CATALOG, label: "catalog", hb: "catalog", run: () => syncCatalog(pool) },
    { on: SYNC_INVENTORY, label: "inventory", hb: "inventory", run: () => syncInventory(pool) },
    { on: SYNC_VENDOR_ITEMS, label: "vendor_items", hb: "vendor_items", run: () => syncVendorItems(pool) },
    { on: SYNC_GIFT_CARDS, label: "gift_cards", hb: "gift_cards", run: () => syncGiftCards(pool) },
    { on: SYNC_TICKETS, label: "tickets", hb: "tickets", run: () => syncTickets(pool) },
    { on: SYNC_OPEN_DOCS, label: "open_docs", hb: "open_docs", run: () => syncOpenDocs(pool) },
    { on: SYNC_LOYALTY_HIST, label: "loyalty_hist", hb: "loyalty_hist", run: () => syncLoyaltyHist(pool) },
    { on: SYNC_RECEIVING_HISTORY, label: "receiving_history", hb: "receiving_history", run: () => syncReceivingHistory(pool) },
  ];
}

async function main() {
  if (DISCOVER_MODE) {
    if (!CONN.trim()) {
      console.error("Set SQL_CONNECTION_STRING in .env (COUNTERPOINT_SYNC_TOKEN not required for discover).");
      process.exit(1);
    }
    const pool = createSqlPool();
    pool.on("error", (err) => console.error("SQL pool error", err));
    try {
      await pool.connect();
      console.info(
        `SQL Server connected. requestTimeout=${SQL_REQUEST_TIMEOUT_MS}ms (SQL_REQUEST_TIMEOUT_MS in .env if queries time out).`,
      );
      await runDiscover(pool);
    } catch (e) {
      console.error("[discover] failed:", e?.message ?? e);
      process.exit(1);
    } finally {
      await pool.close();
    }
    await waitForDiscoverClose();
    process.exit(0);
  }

  if (!SYNC_TOKEN.trim()) {
    console.error("Set COUNTERPOINT_SYNC_TOKEN");
    process.exit(1);
  }
  if (!CONN.trim()) {
    console.error("Set SQL_CONNECTION_STRING");
    process.exit(1);
  }
  bridgeHostnameCached = (await import("node:os")).hostname();
  
  // Start the Bridge Command Dashboard (Port 3001)
  startLocalServer();

  await refreshRosStagingFromHealth();
  console.info(
    "ROS sync health OK",
    rosStagingEnabled ? "(counterpoint staging ingest)" : "(direct entity ingest)",
  );

  logCanonicalSyncOrder();

  const pool = createSqlPool();
  ACTIVE_POOL = pool;
  pool.on("error", (err) => console.error("SQL pool error", err));
  await pool.connect();
  console.info(
    `SQL Server connected. SQL requestTimeout=${SQL_REQUEST_TIMEOUT_MS}ms, ROS fetch timeout=${ROS_FETCH_TIMEOUT_MS}ms (raise SQL_REQUEST_TIMEOUT_MS / ROS_FETCH_TIMEOUT_MS in .env if needed).`,
  );

  await rebuildEffectiveSql(pool);
  validateCounterpointSyncDependencyPlan();

  console.info(
    `[ingest] Mode: ${
      rosStagingEnabled
        ? "staging — batches queue in ROS until staff Apply (Inbound tab)"
        : "direct — each batch writes to live tables (use for bulk / first import)"
    }`,
  );

  if (omitPsTktDocTypFilterEnabled()) {
    console.warn(
      "[compat] PS_TKT_HIST DOC_TYP filters omitted (default; set CP_OMIT_PS_TKT_DOC_TYP_FILTER=0 to enforce). Imports use BUS_DAT / activity only — confirm row types in SSMS if results look wrong.",
    );
  } else if ((process.env.CP_TKT_DOC_TYP_COLUMN ?? "").trim()) {
    console.info(`[compat] Using CP_TKT_DOC_TYP_COLUMN=${process.env.CP_TKT_DOC_TYP_COLUMN.trim()} for PS_TKT_HIST doc type.`);
  }
  if (poVendItemVendorLinkEnabled()) {
    console.info(
      "[compat] CP_IM_ITEM_VENDOR_SOURCE: linking items to vendors via PO_VEND_ITEM (no IM_ITEM.VEND_NO).",
    );
  }

  /** Single canonical pipeline — order is fixed here so ROS seeding stays consistent. */
  const orderedSyncSteps = getOrderedSyncSteps(pool);

  const tick = async () => {
    let hbResp = null;
    try {
      hbResp = await sendHeartbeat("idle", null);
    } catch (e) {
      console.warn("[heartbeat] failed", e.message);
    }

    logToDashboard(`[sync] Starting pass (Request: ${hbResp?.pending_request_id ?? "None"})`);
    BRIDGE_STATE.isSyncing = true;
    BRIDGE_STATE.lastRun = new Date().toISOString();

    for (const step of orderedSyncSteps) {
      if (!step.on) continue;
      BRIDGE_STATE.currentEntity = step.label;
      logToDashboard(`[${step.label}] starting sync...`);
      await sendHeartbeat("syncing", step.hb);
      await runSyncEntity(step.label, step.run);
      logToDashboard(`[${step.label}] ok`);
    }

    BRIDGE_STATE.isSyncing = false;
    BRIDGE_STATE.currentEntity = null;
    logToDashboard("[sync] pass completed");

    if (hbResp?.pending_request_id) {
      try {
        await rosFetch("/api/sync/counterpoint/request/complete", { request_id: hbResp.pending_request_id });
      } catch (e) {
        console.error("[sync-request] complete failed", e.message);
      }
    }

    await sendHeartbeat("idle", null);
  };

  // Only autostart if RUN_ONCE is enabled. Otherwise, stay IDLE until manual trigger or timer.
  if (RUN_ONCE) {
    await tick();
    console.info(
      "RUN_ONCE=1 — one full pass finished. Run START_BRIDGE.cmd again when you want another import (or set RUN_ONCE=0 for timed repeats)."
    );
    await pool.close();
    await waitForEnterBeforeClose();
    process.exit(0);
  } else {
    logToDashboard("Bridge started in IDLE mode. Use dashboard or wait for timer.");
  }

  console.info(`Repeating full sync every ${POLL_MS} ms (set RUN_ONCE=1 for a single pass, then exit).`);
  setInterval(tick, POLL_MS);
}

main().catch(async (e) => {
  console.error(e);
  if (RUN_ONCE && WAIT_AFTER_RUN_ONCE && process.stdin.isTTY) {
    await waitForEnterBeforeClose();
  }
  process.exit(1);
});
