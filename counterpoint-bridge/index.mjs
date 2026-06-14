/**
 * Counterpoint → Riverside OS bridge (Windows-friendly).
 * Run on the Counterpoint SQL host: npm install && npm start
 * Schema probe: npm run discover or DISCOVER_SCHEMA.cmd (SQL only; no ROS token).
 *
 * Entities: staff/users, optional SLS_REP stubs, vendors/categories, catalog, inventory,
 * customers, sales history, open PS_DOC orders, loyalty balances, and gift cards.
 * Heartbeat: idle/syncing each poll cycle; bridge polls for pending sync requests.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
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
    isContinuous: false, // Default to OFF as requested by user
    isSyncing: false,
    currentEntity: null,
    lastRun: null,
    lastRunDurationMs: null,
    error: null,
    syncSummary: {}, // Track which entities have completed successfully
    entityStats: {}, // { lastSync: ISO, durationMs: number, error: string | null }
    totalRecordsLastRun: 0,
    abortRequested: false,
    recentEvents: [], // [{ type: 'error'|'complete'|'start', entity: string, message: string, time: ISO, durationMs: number }]
};

function boolEnv(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null) return fallback;
    const val = String(raw).trim().toLowerCase();
    return val === "1" || val === "true" || val === "yes" || val === "on";
}

function getMigrationSnapshot() {
    const enabledEntities = [
        ["staff", SYNC_STAFF],
        ["sales_rep_stubs", SYNC_SLS_REP_STUBS],
        ["vendors", SYNC_VENDORS],
        ["customers", SYNC_CUSTOMERS],
        ["store_credit_opening", SYNC_STORE_CREDIT_OPENING],
        ["customer_notes", SYNC_CUSTOMER_NOTES],
        ["category_masters", SYNC_CATEGORY_MASTERS],
        ["catalog", SYNC_CATALOG],
        ["inventory", SYNC_INVENTORY],
        ["vendor_items", SYNC_VENDOR_ITEMS],
        ["gift_cards", SYNC_GIFT_CARDS],
        ["tickets", SYNC_TICKETS],
        ["open_docs", SYNC_OPEN_DOCS],
        ["loyalty_hist", SYNC_LOYALTY_HIST],
        ["receiving_history", SYNC_RECEIVING_HISTORY],
        ["ticket_notes", SYNC_TICKET_NOTES],
    ]
        .filter(([, enabled]) => enabled)
        .map(([entity]) => entity);

    const nonIdempotentEntities = enabledEntities.filter((entity) =>
        entity === "gift_cards" || entity === "receiving_history",
    );

    const rerunWarnings = [];
    if (CP_IMPORT_SINCE !== REQUIRED_CP_IMPORT_SINCE) {
        rerunWarnings.push(
            `Historical floor mismatch: this migration expects CP_IMPORT_SINCE=${REQUIRED_CP_IMPORT_SINCE}, but the bridge is running with ${CP_IMPORT_SINCE}.`,
        );
    }
    if (!boolEnv("RUN_ONCE")) {
        rerunWarnings.push(
            "RUN_ONCE is off. This bridge can repeat the import unless an operator stops it.",
        );
    }
    if (BRIDGE_STATE.lastRun || Object.keys(BRIDGE_STATE.syncSummary).length > 0) {
        rerunWarnings.push(
            "A prior bridge run is already recorded in this session. Re-running can duplicate non-idempotent history.",
        );
    }
    if (nonIdempotentEntities.length > 0) {
        rerunWarnings.push(
            `Enabled extra-review rerun entities: ${nonIdempotentEntities.join(", ")}. These rows now have duplicate-skip guardrails, but operators should still review them carefully on repeat migration passes.`,
        );
    }
    if (rosStagingEnabled) {
        rerunWarnings.push(
            "ROS support queue mode is enabled. Import-first rehearsal must post directly into ROS.",
        );
    }

    return {
        migration_intent: "one_time_import",
        source_input: "NCR Counterpoint",
        destination_system_of_record: "Riverside OS after successful import",
        cp_import_since: CP_IMPORT_SINCE,
        run_once: boolEnv("RUN_ONCE"),
        bridge_continuous_mode: BRIDGE_STATE.isContinuous,
        staging_enabled: rosStagingEnabled,
        sync_relaxed_dependencies: SYNC_RELAXED_DEPENDENCIES,
        import_scope: {
            cp_import_scope: (process.env.CP_IMPORT_SCOPE ?? "").trim() || null,
            enabled_entities: enabledEntities,
            query_placeholders_use_cp_import_since: [
                "tickets",
                "customer_notes",
                "loyalty_hist",
                "gift_cards",
                "ticket_notes",
            ].filter((entity) => enabledEntities.includes(entity)),
        },
        non_idempotent_entities: nonIdempotentEntities,
        rerun_warnings: rerunWarnings,
        retirement_checklist: [
            "Verify ROS sync history, unresolved issues, and any support queue rows before declaring migration complete.",
            "Capture the bridge run summary and ROS verification evidence for the cutover record.",
            "Stop the bridge and remove any startup shortcut or scheduled rerun on the Counterpoint host.",
            "Retire bridge credentials or remove the bridge folder after cutover so Counterpoint cannot be imported again by accident.",
        ],
    };
}

function pushEvent(type, entity, message, meta = {}) {
    const ev = { type, entity, message, time: new Date().toISOString(), ...meta };
    BRIDGE_STATE.recentEvents.unshift(ev);
    if (BRIDGE_STATE.recentEvents.length > 50) BRIDGE_STATE.recentEvents.pop();
}

const ENTITY_DEPENDENCIES = {
    'inventory': ['catalog'],
    'tickets': ['customers', 'catalog'],
    'vendor_items': ['vendors', 'catalog'],
    'open_docs': ['customers', 'catalog'],
    'customer_notes': ['customers'],
    'receiving_history': ['vendors', 'catalog']
};


// --- Local Bridge Control Server ---
const BRIDGE_CONTROL_PORT = Number.parseInt(process.env.BRIDGE_CONTROL_PORT ?? "3002", 10);
const BRIDGE_CONTROL_HOST = (process.env.BRIDGE_CONTROL_HOST ?? "0.0.0.0").trim() || "0.0.0.0";

function bridgeControlUrls() {
    const urls = [
        `http://localhost:${BRIDGE_CONTROL_PORT}`,
        `http://${os.hostname()}:${BRIDGE_CONTROL_PORT}`,
    ];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === "IPv4" && !entry.internal) {
                urls.push(`http://${entry.address}:${BRIDGE_CONTROL_PORT}`);
            }
        }
    }
    return Array.from(new Set(urls));
}

const startLocalServer = () => {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        if (req.method === 'OPTIONS') { res.end(); return; }

        if (req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...BRIDGE_STATE,
                logs: LOG_BACKLOG,
                runOnce: process.env.RUN_ONCE === "1",
                migrationPreflight: getMigrationSnapshot(),
            }));
        } else if (req.url === '/api/auto-config') {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Use POST for auto-config." }));
                return;
            }
            if (!ACTIVE_POOL) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "SQL pool not initialized or connected." }));
                return;
            }
            runAutoConfig(ACTIVE_POOL)
                .then((changes) => {
                    validateCounterpointSyncDependencyPlan();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, changes }));
                })
                .catch((err) => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err?.message ?? String(err) }));
                });
        } else if (req.url.startsWith('/api/test-query')) {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const entity = url.searchParams.get('query');

            const executeQuery = async (sqlText) => {
                if (!ACTIVE_POOL) {
                    throw new Error("SQL pool not initialized or connected.");
                }
                const request = ACTIVE_POOL.request();
                let testSql = sqlText.trim();
                if (!/^(SELECT|WITH)\b/i.test(testSql) || /;\s*\S/.test(testSql)) {
                    throw new Error("SQL Query Tester only allows a single read-only SELECT/WITH statement.");
                }
                if (/^\s*SELECT\b/i.test(testSql)) {
                    testSql = limitSqlServerSelectForTester(testSql);
                }
                const result = await request.query(testSql);
                return (result.recordset || []).slice(0, 10);
            };

            if (entity) {
                let querySqlForError = "";
                (async () => {
                    let sqlKey = resolveQueryTesterSqlKey(entity);
                    if (!sqlKey && ACTIVE_POOL) {
                        await rebuildEffectiveSql(ACTIVE_POOL);
                        sqlKey = resolveQueryTesterSqlKey(entity);
                    }
                    if (!sqlKey) {
                        const known = isKnownQueryTesterEntity(entity);
                        const options = queryTesterOptionList().join(', ');
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: known
                                ? `No SQL mapping is available for query entity: ${entity}. Run Auto-config or check Counterpoint table/schema permissions. Available options: ${options}`
                                : `Unknown query entity: ${entity}. Available options: ${options}`,
                        }));
                        return;
                    }
                    const since = (process.env.CP_IMPORT_SINCE ?? "2018-01-01").trim();
                    querySqlForError = String(effectiveSql[sqlKey] ?? "").replace(/__CP_IMPORT_SINCE__/g, since);
                    const rows = await executeQuery(querySqlForError);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, entity, query_key: sqlKey, rows }));
                })()
                    .catch(err => {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: err.message, query: querySqlForError || undefined }));
                    });
            } else if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        if (!data.sql) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: "Missing 'sql' body parameter" }));
                            return;
                        }
                        executeQuery(data.sql)
                            .then(rows => {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: true, rows }));
                            })
                            .catch(err => {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: err.message }));
                            });
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Specify ?query=entity_name or POST { \"sql\": \"...\" }" }));
            }
        } else if (req.url === '/api/settings') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.is_continuous !== undefined) {
                        BRIDGE_STATE.isContinuous = !!data.is_continuous;
                        logToDashboard(`Continuous Sync: ${BRIDGE_STATE.isContinuous ? "ENABLED" : "DISABLED"}`);
                    }
                    if (data.run_once !== undefined) {
                      process.env.RUN_ONCE = data.run_once ? "1" : "0";
                      logToDashboard(`Mode changed: ${data.run_once ? "IMPORT (Once)" : "SYNC (Continuous 15m)"}`);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, isContinuous: BRIDGE_STATE.isContinuous }));
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
        } else if (req.url === '/api/stop') {
            logToDashboard("Manual Sync Abort Requested.");
            BRIDGE_STATE.abortRequested = true;
            pushEvent('abort', null, 'Sync abort requested by user');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } else if (req.url.startsWith('/api/trigger-entity')) {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const entity = url.searchParams.get('name');
            logToDashboard(`Manual trigger: Targeted pull for [${entity}] requested`);

            if (entity === 'full') {
                (async () => {
                    BRIDGE_STATE.isSyncing = true;
                    BRIDGE_STATE.abortRequested = false;
                    pushEvent('start', null, 'Full sync started (manual)');
                    logToDashboard("[sync] Starting full sync sequence...");
                    const preflightSummary = await runImportFirstSourcePreflight(pool);
                    await startImportFirstRun(preflightSummary);
                    const steps = getOrderedSyncSteps();
                    try {
                        for (const step of steps) {
                            if (!step.on) continue;
                            if (BRIDGE_STATE.abortRequested) {
                                logToDashboard('[sync] Aborted by user');
                                pushEvent('abort', step.label, 'Sync aborted before this entity');
                                break;
                            }
                            BRIDGE_STATE.currentEntity = step.label;
                            logToDashboard(`[${step.label}] starting sync...`);
                            await sendHeartbeat("syncing", step.hb);
                            await runSyncEntity(step.label, step.run);
                            BRIDGE_STATE.syncSummary[step.label] = new Date().toISOString();
                            logToDashboard(`[${step.label}] ok`);
                        }
                        await completeImportFirstRun({
                            failed: BRIDGE_STATE.abortRequested,
                            errorMessage: BRIDGE_STATE.abortRequested ? "Manual sync aborted by user." : null,
                            totals: { sync_summary: BRIDGE_STATE.syncSummary },
                        });
                    } catch (err) {
                        await completeImportFirstRun({ failed: true, errorMessage: err.message });
                        throw err;
                    }
                    BRIDGE_STATE.isSyncing = false;
                    BRIDGE_STATE.currentEntity = null;
                    BRIDGE_STATE.abortRequested = false;
                    logToDashboard("[sync] Full sync sequence completed.");
                })().catch(err => {
                    BRIDGE_STATE.isSyncing = false;
                    BRIDGE_STATE.abortRequested = false;
                    pushEvent('error', null, err.message);
                    logToDashboard(`Sync error: ${err.message}`);
                });
                res.end(JSON.stringify({ status: 'triggered', queue: 'all' }));
                return;
            }

            // Resolve dependencies
            const deps = ENTITY_DEPENDENCIES[entity] || [];
            const toRun = [...deps, entity];

            logToDashboard(`[dependency-check] To complete [${entity}], we will run: ${toRun.join(' -> ')}`);

            (async () => {
                BRIDGE_STATE.isSyncing = true;
                BRIDGE_STATE.abortRequested = false;
                const preflightSummary = await runImportFirstSourcePreflight(pool);
                await startImportFirstRun(preflightSummary);
                const steps = getOrderedSyncSteps();
                try {
                    for (const target of toRun) {
                        if (BRIDGE_STATE.abortRequested) {
                            logToDashboard('[sync] Aborted by user');
                            break;
                        }
                        const step = steps.find(s => s.label === target);
                        if (step) {
                            BRIDGE_STATE.currentEntity = step.label;
                            logToDashboard(`[${target}] starting targeted sync...`);
                            await sendHeartbeat("syncing", step.hb);
                            await runSyncEntity(step.label, step.run);
                            BRIDGE_STATE.syncSummary[target] = new Date().toISOString();
                            logToDashboard(`[${target}] ok`);
                        }
                    }
                    await completeImportFirstRun({
                        failed: BRIDGE_STATE.abortRequested,
                        errorMessage: BRIDGE_STATE.abortRequested ? "Manual targeted sync aborted by user." : null,
                        totals: { sync_summary: BRIDGE_STATE.syncSummary, targeted_entity: entity },
                    });
                } catch (err) {
                    await completeImportFirstRun({ failed: true, errorMessage: err.message });
                    throw err;
                }
                BRIDGE_STATE.isSyncing = false;
                BRIDGE_STATE.currentEntity = null;
                BRIDGE_STATE.abortRequested = false;
                logToDashboard(`[sync] Targeted pull for ${entity} finished.`);
            })().catch(err => {
                BRIDGE_STATE.isSyncing = false;
                BRIDGE_STATE.abortRequested = false;
                pushEvent('error', entity, err.message);
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
    });
    server.listen(BRIDGE_CONTROL_PORT, BRIDGE_CONTROL_HOST, () => {
        console.log(`🌐 Bridge Command UI listening on ${BRIDGE_CONTROL_HOST}:${BRIDGE_CONTROL_PORT}`);
        for (const url of bridgeControlUrls()) {
            console.log(`   ${url}`);
        }
    });
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  loadDotEnvContent(fs.readFileSync(p, "utf8"), false);
  console.info(`[env] loaded ${p}`);
}

function loadDotEnvContent(raw, overwrite) {
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
    if (!overwrite && process.env[k] != null) continue;
    process.env[k] = v;
  }
}

function reloadDotEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  loadDotEnvContent(fs.readFileSync(p, "utf8"), true);
  console.info(`[env] reloaded ${p}`);
}

loadDotEnv();

const STATE_FILE = process.env.CURSOR_STATE_FILE ?? path.join(__dirname, ".counterpoint-bridge-state.json");
const REQUIRED_CP_IMPORT_SINCE = "2018-01-01";
const CP_IMPORT_SINCE = (
  process.env.CP_IMPORT_SINCE ?? REQUIRED_CP_IMPORT_SINCE
).trim();

// Helper to get the starting date for queries (either .env default or last success)
function getSyncAnchorDate(entityKey) {
  const state = readState();
  return state[`${entityKey}_last_date`] || CP_IMPORT_SINCE;
}

/** Pass-through so queries retain the history-floor placeholder until execution. */
function expandImportSince(sqlText, anchorDate = CP_IMPORT_SINCE) {
  return String(sqlText ?? "");
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
    return omitPsTktDocTypPredicates(q);
  }
  const col = (process.env.CP_TKT_DOC_TYP_COLUMN ?? "").trim();
  if (col && col !== "DOC_TYP" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
    q = q.replace(/\bh\.DOC_TYP\b/g, `h.${col}`);
    q = q.replace(/\bDOC_TYP\s*=\s*'T'/g, `${col} = 'T'`);
    q = q.replace(/\bDOC_TYP\s*=\s*N'T'/g, `${col} = N'T'`);
  }
  return q;
}

const PS_TKT_DOC_TYPE_COLUMN_PATTERN =
  String.raw`(?:h\.)?(?:(?:\[?(?:DOC_TYP|DOC_TYPE|TKT_TYP)\]?)|(?:h\.\[(?:DOC_TYP|DOC_TYPE|TKT_TYP)\]))`;
const PS_TKT_DOC_TYPE_EQUALS_T_PATTERN =
  String.raw`${PS_TKT_DOC_TYPE_COLUMN_PATTERN}\s*=\s*N?'T'`;

function omitPsTktDocTypPredicates(sqlText) {
  let q = String(sqlText ?? "");
  const equalsTicketType = new RegExp(PS_TKT_DOC_TYPE_EQUALS_T_PATTERN, "gi");
  q = q.replace(new RegExp(String.raw`\s+AND\s+${PS_TKT_DOC_TYPE_EQUALS_T_PATTERN}`, "gi"), "");
  q = q.replace(new RegExp(String.raw`\bWHERE\s+${PS_TKT_DOC_TYPE_EQUALS_T_PATTERN}\s+AND\s+`, "gi"), "WHERE ");
  q = q.replace(new RegExp(String.raw`\bWHERE\s+${PS_TKT_DOC_TYPE_EQUALS_T_PATTERN}\s*$`, "gi"), "WHERE 1=1");
  q = q.replace(equalsTicketType, "1=1");
  return q;
}

/**
 * When SYNC_STORE_CREDIT_OPENING=1, append OR EXISTS(`CP_CUSTOMER_STORE_CREDIT_EXISTS`) before ORDER BY
 * so customers with store credit import even without ticket/note in-range. Fragment must correlate to `c.CUST_NO`.
 */
/** Tail of supported CP_CUSTOMERS_QUERY templates before appending store-credit customer inclusion. */
const CP_CUSTOMERS_ORDER_BY_TAIL = /\s+ORDER\s+BY\s+c\.CUST_NO\s*;?\s*$/i;

function injectStoreCreditCustomerExistsClause(sqlText, storeCreditOn, existsInner) {
  const q = String(sqlText ?? "");
  const inner = String(existsInner ?? "").trim();
  if (!storeCreditOn || !q.trim() || !inner) return q;
  const orderByMatch = q.match(CP_CUSTOMERS_ORDER_BY_TAIL);
  if (!orderByMatch || orderByMatch.index == null) {
    console.warn(
      "[customers] SYNC_STORE_CREDIT_OPENING=1: expert CP_CUSTOMERS_QUERY override must end with \"ORDER BY c.CUST_NO\" for auto-append, or add OR EXISTS(...) manually.",
    );
    return q;
  }
  const body = q.slice(0, orderByMatch.index).trimEnd();
  const orderBy = orderByMatch[0];
  const fromArCustWithWhere = /\bFROM\s+AR_CUST\s+c\s+WHERE\b/i;
  if (fromArCustWithWhere.test(body)) {
    return `${body.replace(fromArCustWithWhere, (match) => `${match} (`)} OR EXISTS (${inner}))${orderBy}`;
  }
  const fromArCust = /\bFROM\s+AR_CUST\s+c\b/i;
  if (fromArCust.test(body)) {
    return `${body} WHERE EXISTS (${inner})${orderBy}`;
  }
  console.warn(
    "[customers] SYNC_STORE_CREDIT_OPENING=1: expert CP_CUSTOMERS_QUERY override must select from AR_CUST c for auto-append, or add OR EXISTS(...) manually.",
  );
  return q;
}

/** Read-only probe: `node index.mjs discover` — needs SQL_CONNECTION_STRING only (no ROS token). */
const DISCOVER_MODE =
  process.argv.includes("discover") || String(process.env.DISCOVER ?? "").toLowerCase() === "1";
const PREFLIGHT_MODE = process.argv[2] === "preflight";
const ALIASES_MODE = process.argv[2] === "aliases";
const NORMALIZATION_MODE = process.argv[2] === "normalization";
const LIGHTSPEED_REFERENCE_MODE = process.argv[2] === "lightspeed-reference";
const AUTOCONFIG_MODE = process.argv[2] === "auto-config";
const SQL_SMOKE_MODE = process.argv[2] === "sql-smoke";
const DRY_RUN_MODE = process.argv.includes("--dry-run");

const ROS_BASE_URL = (process.env.ROS_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SYNC_TOKEN = process.env.COUNTERPOINT_SYNC_TOKEN ?? "";
const CONN = process.env.SQL_CONNECTION_STRING ?? "";
/** mssql default requestTimeout is 15s — large EXISTS / ticket-scoped queries often exceed that on real CP DBs. */
const SQL_REQUEST_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.SQL_REQUEST_TIMEOUT_MS ?? "600000", 10));
const SQL_CONNECT_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.SQL_CONNECT_TIMEOUT_MS ?? "60000", 10));
const SQL_PROGRESS_LOG_MS = Math.max(10000, Number.parseInt(process.env.SQL_PROGRESS_LOG_MS ?? "30000", 10));
const CATALOG_SQL_STALL_TIMEOUT_MS = Math.max(30000, Number.parseInt(process.env.CATALOG_SQL_STALL_TIMEOUT_MS ?? "180000", 10));
/** Node fetch has no default body timeout; large vendor/customer batches to ROS need a high ceiling. */
const ROS_FETCH_TIMEOUT_MS = Math.max(15000, Number.parseInt(process.env.ROS_FETCH_TIMEOUT_MS ?? "300000", 10));
const ROS_FETCH_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.ROS_FETCH_MAX_ATTEMPTS ?? "6", 10));
const ROS_MIN_REQUEST_INTERVAL_MS = Math.max(0, Number.parseInt(process.env.ROS_MIN_REQUEST_INTERVAL_MS ?? "75", 10));
const ROS_RATE_LIMIT_FALLBACK_WAIT_MS = Math.max(
  1000,
  Number.parseInt(process.env.ROS_RATE_LIMIT_FALLBACK_WAIT_MS ?? "65000", 10),
);
let nextRosRequestAt = 0;
let rosRequestGate = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRosRequestSlot() {
  if (ROS_MIN_REQUEST_INTERVAL_MS <= 0) return;

  let releaseGate = () => {};
  const previousGate = rosRequestGate;
  rosRequestGate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  await previousGate;
  try {
    const waitMs = Math.max(0, nextRosRequestAt - Date.now());
    if (waitMs > 0) {
      await delay(waitMs);
    }
    nextRosRequestAt = Date.now() + ROS_MIN_REQUEST_INTERVAL_MS;
  } finally {
    releaseGate();
  }
}

function retryAfterMs(res) {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(1000, Math.ceil(seconds * 1000));
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(1000, dateMs - Date.now());
    }
  }

  const windowSeconds = Number.parseFloat(res.headers.get("x-ratelimit-window") ?? "");
  if (Number.isFinite(windowSeconds) && windowSeconds > 0) {
    return Math.max(1000, Math.ceil(windowSeconds * 1000));
  }

  return ROS_RATE_LIMIT_FALLBACK_WAIT_MS;
}

/**
 * mssql only parses timeouts when config is a merged object (server/user/…).
 * `{ connectionString, requestTimeout }` leaves server undefined — requestTimeout is ignored and Tedious stays at 15s.
 */
function createSqlPool() {
  const conn = CONN.trim();
  if (!conn) return new sql.ConnectionPool(conn);
  try {
    const parsed = sql.ConnectionPool.parseConnectionString(conn);
    const usesIpServer = net.isIP(parsed.server ?? "") !== 0;
    const trustsServerCertificate = parsed.options?.trustServerCertificate === true;
    const explicitTlsServerName = String(process.env.SQL_TLS_SERVERNAME ?? "").trim();
    const normalizedOptions = { ...(parsed.options ?? {}) };
    if (usesIpServer && trustsServerCertificate) {
      normalizedOptions.serverName =
        explicitTlsServerName || normalizedOptions.serverName || "localhost";
      console.info(
        `[sql] SQL host is an IP (${parsed.server}); using TLS serverName "${normalizedOptions.serverName}" for driver compatibility.`,
      );
    }
    return new sql.ConnectionPool({
      ...parsed,
      options: normalizedOptions,
      requestTimeout: SQL_REQUEST_TIMEOUT_MS,
      connectionTimeout: SQL_CONNECT_TIMEOUT_MS,
    });
  } catch (e) {
    console.warn("[sql] parseConnectionString failed; falling back to raw string (add Request Timeout=600000 to the string):", e?.message ?? e);
    return new sql.ConnectionPool(conn);
  }
}
const POLL_MS = 10000; // Fast poll for triggers (10s)
const AUTO_SYNC_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "900000", 10); // Auto-sync (15m default)
let lastAutoRunTime = 0;
const RUN_ONCE =
  process.env.RUN_ONCE === "1" ||
  (process.env.RUN_ONCE == null &&
    String(process.env.COUNTERPOINT_SYNC_ONCE ?? "").toLowerCase() === "true");
/** When RUN_ONCE=1, wait for Enter before exiting so the console window stays open (Windows-friendly). Set to 0 to exit immediately. */
const WAIT_AFTER_RUN_ONCE =
  process.env.WAIT_AFTER_RUN_ONCE !== "0" && String(process.env.WAIT_AFTER_RUN_ONCE ?? "").toLowerCase() !== "false";
const BATCH = Math.max(1, Number.parseInt(process.env.BATCH_SIZE ?? "100", 10));

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

const ALLOW_SQL_ENV_OVERRIDES = envFlag("CP_SQL_ENV_OVERRIDES", false);
const IMPORT_FIRST_MODE = envFlag("CP_IMPORT_FIRST_MODE", true);
const ALLOW_IMPORT_WITH_PREFLIGHT_BLOCKERS = envFlag("CP_ALLOW_IMPORT_WITH_PREFLIGHT_BLOCKERS", false);
function configuredSql(name) {
  return ALLOW_SQL_ENV_OVERRIDES ? process.env[name] ?? "" : "";
}

function requireImportFirstIngestMode() {
  if (!IMPORT_FIRST_MODE && !DRY_RUN_MODE) {
    throw new Error(
      "CP_IMPORT_FIRST_MODE must remain enabled for Counterpoint go-live import. Legacy direct/staging ingest is disabled for production import runs.",
    );
  }
}

const SYNC_CUSTOMERS = envFlag("SYNC_CUSTOMERS", true);
const SYNC_INVENTORY = envFlag("SYNC_INVENTORY", true);
const SYNC_CATALOG = envFlag("SYNC_CATALOG", true);
const SYNC_GIFT_CARDS = envFlag("SYNC_GIFT_CARDS", true);
const SYNC_TICKETS = envFlag("SYNC_TICKETS", true);
const SYNC_VENDORS = envFlag("SYNC_VENDORS", true);
const SYNC_STAFF = envFlag("SYNC_STAFF", true);
/** When not 1, vendors use a fast `PO_VEND`-only query (bulk migration). Set to 1 to run heavy filtered CP_VENDORS_QUERY (active items / ticket EXISTS). */
const SYNC_VENDORS_FILTERED = envFlag("SYNC_VENDORS_FILTERED", false);
const SYNC_CUSTOMER_NOTES = envFlag("SYNC_CUSTOMER_NOTES", true);
const SYNC_CATEGORY_MASTERS = envFlag("SYNC_CATEGORY_MASTERS", true);
const SYNC_LOYALTY_HIST = false; // Forced false: we only need current loyalty balances, no history.
const SYNC_VENDOR_ITEMS = envFlag("SYNC_VENDOR_ITEMS", true);
const SYNC_STORE_CREDIT_OPENING = envFlag("SYNC_STORE_CREDIT_OPENING", true);
const SYNC_OPEN_DOCS = envFlag("SYNC_OPEN_DOCS", true);
const SYNC_RECEIVING_HISTORY = envFlag("SYNC_RECEIVING_HISTORY", false);
const SYNC_TICKET_NOTES = envFlag("SYNC_TICKET_NOTES", true);
const CP_CUSTOMER_STORE_CREDIT_EXISTS_RAW = configuredSql("CP_CUSTOMER_STORE_CREDIT_EXISTS");
const CP_CUSTOMERS_QUERY = injectStoreCreditCustomerExistsClause(
  applyCounterpointSqlCompat(expandImportSince(configuredSql("CP_CUSTOMERS_QUERY"))),
  SYNC_STORE_CREDIT_OPENING,
  expandImportSince(CP_CUSTOMER_STORE_CREDIT_EXISTS_RAW),
);
const CP_INVENTORY_QUERY = applyCounterpointSqlCompat(
  expandImportSince(configuredSql("CP_INVENTORY_QUERY")),
);
const CP_CATALOG_QUERY = applyCounterpointSqlCompat(
  pipeImItemVendorSql(configuredSql("CP_CATALOG_QUERY")),
);
const CP_CATALOG_CELLS_QUERY = applyCounterpointSqlCompat(
  expandImportSince(configuredSql("CP_CATALOG_CELLS_QUERY")),
);
const CP_GIFT_CARDS_QUERY = expandImportSince(configuredSql("CP_GIFT_CARDS_QUERY"));
const CP_GFC_HIST_QUERY = ""; // Forced empty: we only need current gift balances, no history.
const CP_TICKETS_QUERY = applyCounterpointSqlCompat(
  stripTrailingOrderBy(expandImportSince(configuredSql("CP_TICKETS_QUERY"))),
);
const CP_TICKET_LINES_QUERY = applyCounterpointSqlCompat(
  expandImportSince(configuredSql("CP_TICKET_LINES_QUERY")),
);
const CP_TICKET_PAYMENTS_QUERY = applyCounterpointSqlCompat(
  expandImportSince(configuredSql("CP_TICKET_PAYMENTS_QUERY")),
);
const CP_TICKET_CELLS_QUERY = applyCounterpointSqlCompat(
  expandImportSince(configuredSql("CP_TICKET_CELLS_QUERY")),
);
const CP_TICKET_GIFT_QUERY = ""; // Forced empty: we only need current gift balances, no history.
const CP_LOYALTY_HIST_QUERY = ""; // Forced empty: we only need current loyalty balances, no history.
const CP_VEND_ITEM_QUERY = applyCounterpointSqlCompat(
  applyImItemVendorColumn(expandImportSince(configuredSql("CP_VEND_ITEM_QUERY"))),
);
const CP_VENDORS_QUERY = applyCounterpointSqlCompat(
  pipeImItemVendorSql(configuredSql("CP_VENDORS_QUERY")),
);
const CP_CUSTOMER_NOTES_QUERY = expandImportSince(configuredSql("CP_CUSTOMER_NOTES_QUERY"));
const CP_CATEGORY_MASTERS_QUERY = expandImportSince(configuredSql("CP_CATEGORY_MASTERS_QUERY"));
const CP_USERS_QUERY = expandImportSince(configuredSql("CP_USERS_QUERY"));
const CP_SALES_REPS_QUERY = expandImportSince(configuredSql("CP_SALES_REPS_QUERY"));
const CP_BUYERS_QUERY = expandImportSince(configuredSql("CP_BUYERS_QUERY"));
const CP_STORE_CREDIT_QUERY = expandImportSince(configuredSql("CP_STORE_CREDIT_QUERY"));
const CP_OPEN_DOCS_QUERY = expandImportSince(configuredSql("CP_OPEN_DOCS_QUERY"));
const CP_OPEN_DOC_LINES_QUERY = expandImportSince(configuredSql("CP_OPEN_DOC_LINES_QUERY"));
const CP_OPEN_DOC_PMT_QUERY = expandImportSince(configuredSql("CP_OPEN_DOC_PMT_QUERY"));
const CP_RECEIVING_HISTORY_QUERY = expandImportSince(configuredSql("CP_RECEIVING_HISTORY_QUERY"));
const CP_TICKET_NOTES_QUERY = expandImportSince(configuredSql("CP_TICKET_NOTES_QUERY"));
const BRIDGE_VERSION = "0.7.4";

if (!PREFLIGHT_MODE && !ALIASES_MODE && !NORMALIZATION_MODE && !LIGHTSPEED_REFERENCE_MODE) {
  console.info(
    `[env] effective mode RUN_ONCE=${RUN_ONCE ? "1" : "0"} WAIT_AFTER_RUN_ONCE=${WAIT_AFTER_RUN_ONCE ? "1" : "0"} ` +
      `SYNC_LOYALTY_HIST=${SYNC_LOYALTY_HIST ? "1" : "0"} CP_GFC_HIST_QUERY=${CP_GFC_HIST_QUERY.trim() ? "set" : "empty"} ` +
      `CP_TICKET_GIFT_QUERY=${CP_TICKET_GIFT_QUERY.trim() ? "set" : "empty"}`,
  );
}

if (!PREFLIGHT_MODE && !ALIASES_MODE && !NORMALIZATION_MODE && !LIGHTSPEED_REFERENCE_MODE && (SYNC_LOYALTY_HIST || CP_LOYALTY_HIST_QUERY.trim() || CP_GFC_HIST_QUERY.trim() || CP_TICKET_GIFT_QUERY.trim())) {
  console.error(
    "[cutover-safety] Snapshot-only cutover requires SYNC_LOYALTY_HIST=0 and empty CP_LOYALTY_HIST_QUERY, CP_GFC_HIST_QUERY, and CP_TICKET_GIFT_QUERY.",
  );
  process.exit(1);
}

/** Fast vendor list — no IM_ITEM / PS_TKT_HIST joins (avoids timeouts & missing DOC_TYP / VEND_NO). */
const CP_VENDORS_QUERY_SIMPLE = `SELECT RTRIM(LTRIM(VEND_NO)) AS vend_no, RTRIM(LTRIM(NAM)) AS name, RTRIM(LTRIM(TERMS_COD)) AS payment_terms FROM PO_VEND WHERE VEND_NO IS NOT NULL ORDER BY VEND_NO`;

/** When `SYNC_VENDORS_FILTERED` is not 1, optional full SQL override for the fast path (PO_VEND column drift). */
const CP_VENDORS_FAST_QUERY = expandImportSince(configuredSql("CP_VENDORS_FAST_QUERY")).trim();

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
let _effectiveSqlBase = {};
let effectiveSql = new Proxy(_effectiveSqlBase, {
  set(target, prop, val) {
    target[prop] = val;
    return true;
  },
  get(target, prop) {
    const val = target[prop];
    if (typeof val === 'string') {
      return val.replace(/__CP_IMPORT_SINCE__/g, getSyncAnchorDate(prop));
    }
    return val;
  }
});
let lastAutoConfigChanges = [];
/** When true, POST `/api/sync/counterpoint/staging` with `{ entity, payload }` (from ROS health). */
let rosStagingEnabled = false;
let bridgeHostnameCached = "";
let activeImportRunId = null;

function initEffectiveSqlFromConstants() {
  Object.assign(effectiveSql, {
    customers: injectStoreCreditCustomerExistsClause(
      applyCounterpointSqlCompat(expandImportSince(configuredSql("CP_CUSTOMERS_QUERY"))),
      SYNC_STORE_CREDIT_OPENING,
      expandImportSince(process.env.CP_CUSTOMER_STORE_CREDIT_EXISTS ?? ""),
    ),
    inventory: applyCounterpointSqlCompat(expandImportSince(configuredSql("CP_INVENTORY_QUERY"))),
    catalog: applyCounterpointSqlCompat(pipeImItemVendorSql(configuredSql("CP_CATALOG_QUERY"))),
    catalog_cells: applyCounterpointSqlCompat(expandImportSince(configuredSql("CP_CATALOG_CELLS_QUERY"))),
    category_masters: expandImportSince(configuredSql("CP_CATEGORY_MASTERS_QUERY")),
    tickets: applyCounterpointSqlCompat(
      stripTrailingOrderBy(expandImportSince(configuredSql("CP_TICKETS_QUERY"))),
    ),
    ticket_lines: applyCounterpointSqlCompat(expandImportSince(configuredSql("CP_TICKET_LINES_QUERY"))),
    ticket_payments: applyCounterpointSqlCompat(expandImportSince(configuredSql("CP_TICKET_PAYMENTS_QUERY"))),
    ticket_cells: applyCounterpointSqlCompat(expandImportSince(configuredSql("CP_TICKET_CELLS_QUERY"))),
    ticket_gift: "",
    gift_cards: expandImportSince(configuredSql("CP_GIFT_CARDS_QUERY")),
    gfc_hist: "",
    loyalty: "",
    vend_item: applyCounterpointSqlCompat(
      applyImItemVendorColumn(expandImportSince(configuredSql("CP_VEND_ITEM_QUERY"))),
    ),
    vendors_filtered: applyCounterpointSqlCompat(pipeImItemVendorSql(configuredSql("CP_VENDORS_QUERY"))),
    customer_notes: expandImportSince(configuredSql("CP_CUSTOMER_NOTES_QUERY")),
    users: expandImportSince(configuredSql("CP_USERS_QUERY")),
    sales_reps: expandImportSince(configuredSql("CP_SALES_REPS_QUERY")),
    buyers: expandImportSince(configuredSql("CP_BUYERS_QUERY")),
    store_credit: expandImportSince(configuredSql("CP_STORE_CREDIT_QUERY")),
    open_docs: expandImportSince(configuredSql("CP_OPEN_DOCS_QUERY")),
    open_doc_lines: expandImportSince(configuredSql("CP_OPEN_DOC_LINES_QUERY")),
    open_doc_pmt: expandImportSince(configuredSql("CP_OPEN_DOC_PMT_QUERY")),
    receiving_history: expandImportSince(configuredSql("CP_RECEIVING_HISTORY_QUERY")),
    ticket_notes: expandImportSince(configuredSql("CP_TICKET_NOTES_QUERY")),
    vendors_fast_simple: expandImportSince(configuredSql("CP_VENDORS_FAST_QUERY")).trim() || CP_VENDORS_QUERY_SIMPLE,
  });
}
initEffectiveSqlFromConstants();

const QUERY_TESTER_ENTITY_ALIASES = {
  staff: ["users"],
  sales_rep_stubs: ["sales_reps"],
  vendors: ["vendors_filtered", "vendors_fast_simple"],
  store_credit_opening: ["store_credit"],
  vendor_items: ["vend_item"],
  open_documents: ["open_docs"],
  open_doc_payments: ["open_doc_pmt"],
  loyalty_hist: ["loyalty"],
  categories: ["category_masters"],
  receiving: ["receiving_history"],
  orders: ["tickets"],
  orders_tickets: ["tickets"],
};

function normalizeQueryTesterEntity(entity) {
  return String(entity ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function queryTesterCandidates(entity) {
  const normalized = normalizeQueryTesterEntity(entity);
  if (!normalized) return [];
  const aliases = QUERY_TESTER_ENTITY_ALIASES[normalized] ?? [];
  return [...new Set([normalized, ...aliases])];
}

function resolveQueryTesterSqlKey(entity) {
  for (const key of queryTesterCandidates(entity)) {
    if (String(effectiveSql[key] ?? "").trim()) {
      return key;
    }
  }
  return null;
}

function isKnownQueryTesterEntity(entity) {
  const normalized = normalizeQueryTesterEntity(entity);
  return (
    queryTesterCandidates(entity).some((key) => Object.prototype.hasOwnProperty.call(_effectiveSqlBase, key)) ||
    Object.prototype.hasOwnProperty.call(QUERY_TESTER_ENTITY_ALIASES, normalized)
  );
}

function queryTesterOptionList() {
  return [...new Set([...Object.keys(_effectiveSqlBase), ...Object.keys(QUERY_TESTER_ENTITY_ALIASES)])].sort();
}

function limitSqlServerSelectForTester(sqlText) {
  if (/^\s*SELECT\s+(?:DISTINCT\s+)?TOP\b/i.test(sqlText)) {
    return sqlText;
  }
  if (/^\s*SELECT\s+DISTINCT\b/i.test(sqlText)) {
    return sqlText.replace(/^\s*SELECT\s+DISTINCT\b/i, "SELECT DISTINCT TOP 10");
  }
  return sqlText.replace(/^\s*SELECT\b/i, "SELECT TOP 10");
}

/** Full customer list (no ticket/note filter). */
const SQL_MAX_CUSTOMERS = `SELECT RTRIM(LTRIM(CAST(c.CUST_NO AS NVARCHAR(64)))) AS cust_no, RTRIM(LTRIM(c.FST_NAM)) AS first_name, RTRIM(LTRIM(c.LST_NAM)) AS last_name, RTRIM(LTRIM(c.NAM)) AS full_name, RTRIM(LTRIM(c.EMAIL_ADRS_1)) AS email, RTRIM(LTRIM(c.PHONE_1)) AS phone, RTRIM(LTRIM(c.ADRS_1)) AS address_line1, RTRIM(LTRIM(c.ADRS_2)) AS address_line2, RTRIM(LTRIM(c.CITY)) AS city, RTRIM(LTRIM(c.STATE)) AS state, RTRIM(LTRIM(c.ZIP_COD)) AS postal_code, RTRIM(LTRIM(c.CUST_TYP)) AS cust_typ, c.LOY_PTS_BAL AS pts_bal, RTRIM(LTRIM(c.SLS_REP)) AS sls_rep FROM AR_CUST c ORDER BY c.CUST_NO`;

function buildFlexMaxCustomersSql(ptsCol, entries) {
  const arCust = entries ? columnSet(entries, "AR_CUST") : null;
  const textCol = (col, alias, width = 255) =>
    arCust?.has(col)
      ? `RTRIM(LTRIM(CAST(c.[${col}] AS NVARCHAR(${width})))) AS ${alias}`
      : `CAST(NULL AS NVARCHAR(${width})) AS ${alias}`;
  const moneyCol = (col, alias) =>
    arCust?.has(col)
      ? `CAST(ISNULL(c.[${col}], 0) AS DECIMAL(18,2)) AS ${alias}`
      : `CAST(NULL AS DECIMAL(18,2)) AS ${alias}`;
  const pointsExpr = arCust?.has(ptsCol)
    ? `c.[${ptsCol}] AS pts_bal`
    : "CAST(NULL AS INT) AS pts_bal";
  const fields = [
    textCol("CUST_NO", "cust_no", 64),
    textCol("FST_NAM", "first_name"),
    textCol("LST_NAM", "last_name"),
    textCol("NAM", "full_name"),
    textCol("EMAIL_ADRS_1", "email"),
    textCol("PHONE_1", "phone"),
    textCol("ADRS_1", "address_line1"),
    textCol("ADRS_2", "address_line2"),
    textCol("CITY", "city"),
    textCol("STATE", "state", 64),
    textCol("ZIP_COD", "postal_code", 64),
    textCol("CUST_TYP", "cust_typ", 64),
    pointsExpr,
    textCol("SLS_REP", "sls_rep", 64),
    moneyCol("BAL", "ar_balance"),
  ];
  const where = arCust?.has("CUST_NO")
    ? " WHERE NULLIF(RTRIM(LTRIM(CAST(c.[CUST_NO] AS NVARCHAR(64)))), N'') IS NOT NULL"
    : "";
  const order = arCust?.has("CUST_NO") ? " ORDER BY c.[CUST_NO]" : "";
  return `SELECT ${fields.join(", ")} FROM AR_CUST c${where}${order}`;
}

function sqlMaxCatalog(costCol) {
  return `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS item_no, RTRIM(LTRIM(i.DESCR)) AS descr, i.LONG_DESCR AS long_descr, RTRIM(LTRIM(i.CATEG_COD)) AS categ_cod, RTRIM(LTRIM(i.VEND_NO)) AS vend_no, CASE WHEN EXISTS (SELECT 1 FROM IM_INV_CELL g WHERE g.ITEM_NO = i.ITEM_NO) THEN 'Y' ELSE 'N' END AS is_grd, p.PRC_1 AS prc_1, p.PRC_2 AS prc_2, p.PRC_3 AS prc_3, inv.${costCol} AS lst_cost, b.BARCOD AS barcode FROM IM_ITEM i LEFT JOIN IM_PRC p ON p.ITEM_NO = i.ITEM_NO LEFT JOIN IM_INV inv ON inv.ITEM_NO = i.ITEM_NO AND inv.LOC_ID = 'MAIN' LEFT JOIN IM_BARCOD b ON b.ITEM_NO = i.ITEM_NO WHERE RTRIM(LTRIM(i.ITEM_NO)) <> N'' ORDER BY i.ITEM_NO`;
}

function sqlMaxInventory(costCol) {
  return `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS sku, CAST(i.QTY_ON_HND AS INT) AS stock_on_hand, RTRIM(LTRIM(i.ITEM_NO)) AS counterpoint_item_key, i.${costCol} AS last_cost FROM IM_INV i WHERE i.ITEM_NO IS NOT NULL AND i.LOC_ID = 'MAIN'`;
}

const SQL_MAX_VEND_ITEM = `SELECT RTRIM(LTRIM(vi.VEND_NO)) AS vend_no, RTRIM(LTRIM(vi.ITEM_NO)) AS item_no, RTRIM(LTRIM(vi.VEND_ITEM_NO)) AS vend_item_no, vi.UNIT_COST AS vend_cost FROM PO_VEND_ITEM vi ORDER BY vi.VEND_NO, vi.ITEM_NO`;

const SQL_MAX_CATEGORY_MASTERS = `SELECT DISTINCT RTRIM(LTRIM(i.CATEG_COD)) AS cp_category, COALESCE(RTRIM(LTRIM(c.DESCR)), RTRIM(LTRIM(i.CATEG_COD))) AS display_name FROM IM_ITEM i LEFT JOIN IM_CATEG c ON c.CATEG_COD = i.CATEG_COD WHERE RTRIM(LTRIM(i.ITEM_NO)) <> N'' AND NULLIF(RTRIM(LTRIM(i.CATEG_COD)), N'') IS NOT NULL ORDER BY cp_category`;

/** Primary stock location for maximal catalog + inventory templates (many CP DBs are not `MAIN`). */
function sqlLocId() {
  const raw = (process.env.CP_CATALOG_INV_LOC_ID ?? process.env.CP_INVENTORY_LOC_ID ?? "MAIN").trim();
  return raw || "MAIN";
}

function escapeSqlStringLiteral(s) {
  return String(s).replace(/'/g, "''");
}

function normalizedSqlText(alias, column, width = 64) {
  return `UPPER(RTRIM(LTRIM(CONVERT(NVARCHAR(${width}), ${alias}.[${column}]))))`;
}

function itemStatusImportPredicate(alias, column) {
  const normalized = normalizedSqlText(alias, column, 64);
  const upperColumn = String(column ?? "").toUpperCase();
  if (upperColumn.includes("ACTIVE") && !upperColumn.includes("INACTIVE")) {
    return `(${alias}.[${column}] IS NULL OR ${normalized} IN (N'1', N'Y', N'YES', N'T', N'TRUE', N'A', N'ACTIVE'))`;
  }
  if (upperColumn.includes("INACT") || upperColumn.includes("DISCONT") || upperColumn.includes("OBSOLETE")) {
    return `(${alias}.[${column}] IS NULL OR ${normalized} NOT IN (N'1', N'Y', N'YES', N'T', N'TRUE', N'I', N'INACTIVE', N'D', N'DISC', N'DISCONT', N'DISCONTINUED', N'OBSOLETE'))`;
  }
  return `(${alias}.[${column}] IS NULL OR ${normalized} NOT IN (N'I', N'INACTIVE', N'D', N'DISC', N'DISCONT', N'DISCONTINUED', N'OBSOLETE', N'VOID', N'DELETED'))`;
}

function openDocActivePredicate(headerSet, alias) {
  const predicates = [];
  const docStatus = pickColumn(headerSet, ["DOC_STAT", "DOC_STATUS", "STA_COD", "STATUS", "STAT"]);
  const docVoid = pickColumn(headerSet, ["VOID_FLG", "VOIDED", "VOID_FLAG", "IS_VOID"]);
  const docClosedAt = pickColumn(headerSet, ["CLOSE_DAT", "CLSD_DAT", "CLOSED_DAT", "CLOSED_AT", "FULFILL_DAT"]);
  if (docStatus) {
    predicates.push(
      `(${alias}.[${docStatus}] IS NULL OR ${normalizedSqlText(alias, docStatus, 32)} NOT IN (N'C', N'CL', N'CLS', N'CLOSED', N'COMPLETE', N'COMPLETED', N'V', N'VOID', N'VOIDED'))`,
    );
  }
  if (docVoid) {
    predicates.push(
      `(${alias}.[${docVoid}] IS NULL OR ${normalizedSqlText(alias, docVoid, 32)} NOT IN (N'1', N'Y', N'YES', N'T', N'TRUE'))`,
    );
  }
  if (docClosedAt) {
    predicates.push(`${alias}.[${docClosedAt}] IS NULL`);
  }
  return predicates.length > 0 ? predicates.join(" AND ") : "1=1";
}

function counterpointItemActivityPredicates(entries, itemAlias, locId) {
  const predicates = [];
  const locEsc = escapeSqlStringLiteral(locId);
  const imInv = entries ? columnSet(entries, "IM_INV") : null;
  const invQty = pickColumn(imInv, ["QTY_ON_HND", "QTY_AVAIL", "QTY"]);
  if (imInv?.has("ITEM_NO") && invQty) {
    const invLoc = imInv.has("LOC_ID") ? ` AND scope_inv.[LOC_ID] = N'${locEsc}'` : "";
    predicates.push(
      `EXISTS (SELECT 1 FROM IM_INV scope_inv WHERE scope_inv.[ITEM_NO] = ${itemAlias}.[ITEM_NO]${invLoc} AND ISNULL(scope_inv.[${invQty}], 0) <> 0)`,
    );
  }

  const tkt = entries ? columnSet(entries, "PS_TKT_HIST") : null;
  const tktLin = entries ? columnSet(entries, "PS_TKT_HIST_LIN") : null;
  const tktNo = pickColumn(tkt, ["TKT_NO", "DOC_NO"]);
  const tktDate = pickColumn(tkt, ["BUS_DAT", "TKT_DT", "DOC_DT"]);
  const tktJoin = pickColumn(tkt, ["DOC_ID", "TKT_NO", "DOC_NO"]);
  const tktLineJoin = pickColumn(tktLin, [tktJoin, "DOC_ID", "TKT_NO"]);
  const tktLinePairs = ticketJoinPairs(tkt, tktLin, tktJoin, tktLineJoin);
  const tktLinePredicate = ticketJoinPredicate("scope_th", "scope_tl", tktLinePairs);
  if (tkt?.has(tktDate) && tktLin?.has("ITEM_NO") && tktLinePredicate) {
    predicates.push(
      `EXISTS (SELECT 1 FROM PS_TKT_HIST_LIN scope_tl INNER JOIN PS_TKT_HIST scope_th ON ${tktLinePredicate} WHERE scope_tl.[ITEM_NO] = ${itemAlias}.[ITEM_NO] AND scope_th.[${tktDate}] >= '__CP_IMPORT_SINCE__')`,
    );
  }

  const psDocHdr = entries ? (columnSet(entries, "PS_DOC_HDR") ?? columnSet(entries, "PS_DOC")) : null;
  const psDocTable = columnSet(entries, "PS_DOC_HDR") ? "PS_DOC_HDR" : columnSet(entries, "PS_DOC") ? "PS_DOC" : "";
  const psDocLin = entries ? columnSet(entries, "PS_DOC_LIN") : null;
  const docRef = pickColumn(psDocHdr, ["DOC_ID", "DOC_NO", "TKT_NO"]);
  const lineDoc = pickColumn(psDocLin, [docRef, "DOC_ID", "DOC_NO", "TKT_NO"]);
  const lineJoinPairs = ticketJoinPairs(psDocHdr, psDocLin, docRef, lineDoc);
  const lineJoinPredicate = ticketJoinPredicate("scope_dh", "scope_dl", lineJoinPairs);
  if (psDocTable && psDocLin?.has("ITEM_NO") && lineJoinPredicate) {
    predicates.push(
      `EXISTS (SELECT 1 FROM PS_DOC_LIN scope_dl INNER JOIN ${psDocTable} scope_dh ON ${lineJoinPredicate} WHERE scope_dl.[ITEM_NO] = ${itemAlias}.[ITEM_NO] AND ${openDocActivePredicate(psDocHdr, "scope_dh")})`,
    );
  }

  const recvHeaderTable = entries && columnSet(entries, "PO_RECVR_HIST")
    ? "PO_RECVR_HIST"
    : entries && columnSet(entries, "PO_RECVR")
      ? "PO_RECVR"
      : "";
  const recvLineTable = entries && columnSet(entries, "PO_RECVR_HIST_LIN")
    ? "PO_RECVR_HIST_LIN"
    : entries && columnSet(entries, "PO_RECVR_LIN")
      ? "PO_RECVR_LIN"
      : "";
  const recvHeader = recvHeaderTable ? columnSet(entries, recvHeaderTable) : null;
  const recvLine = recvLineTable ? columnSet(entries, recvLineTable) : null;
  const recvHeaderJoin = pickColumn(recvHeader, ["RECVR_NO", "RECV_NO", "DOC_ID", "PO_NO"]);
  const recvLineJoin = pickColumn(recvLine, [recvHeaderJoin, "RECVR_NO", "RECV_NO", "DOC_ID", "PO_NO"].filter(Boolean));
  const recvHeaderDate = pickColumn(recvHeader, ["RECVR_DAT", "RECV_DAT", "RECEIVED_DAT", "RECVD_DAT", "POST_DAT"]);
  const recvLineDate = pickColumn(recvLine, ["RECVR_DAT", "RECV_DAT", "RECEIVED_DAT", "RECVD_DAT", "POST_DAT"]);
  if (recvHeaderTable && recvLineTable && recvHeaderJoin && recvLineJoin && recvLine?.has("ITEM_NO") && (recvHeaderDate || recvLineDate)) {
    const dateAlias = recvHeaderDate ? "scope_rh" : "scope_rl";
    const dateCol = recvHeaderDate ?? recvLineDate;
    predicates.push(
      `EXISTS (SELECT 1 FROM ${recvLineTable} scope_rl INNER JOIN ${recvHeaderTable} scope_rh ON scope_rh.[${recvHeaderJoin}] = scope_rl.[${recvLineJoin}] WHERE scope_rl.[ITEM_NO] = ${itemAlias}.[ITEM_NO] AND ${dateAlias}.[${dateCol}] >= '__CP_IMPORT_SINCE__')`,
    );
  } else if (recvLineTable && recvLine?.has("ITEM_NO")) {
    const recvDate = pickColumn(recvLine, ["RECVR_DAT", "RECV_DAT", "RECEIVED_DAT", "RECVD_DAT", "POST_DAT"]);
    if (recvDate) {
      predicates.push(
        `EXISTS (SELECT 1 FROM ${recvLineTable} scope_rl WHERE scope_rl.[ITEM_NO] = ${itemAlias}.[ITEM_NO] AND scope_rl.[${recvDate}] >= '__CP_IMPORT_SINCE__')`,
      );
    }
  }
  return predicates;
}

function buildCounterpointItemScopePredicate(entries, itemAlias, locId) {
  const imItem = entries ? columnSet(entries, "IM_ITEM") : null;
  const base = `NULLIF(RTRIM(LTRIM(${itemAlias}.[ITEM_NO])), N'') IS NOT NULL`;
  if (!imItem?.has("ITEM_NO")) return base;

  const statusColumn = pickColumn(imItem, [
    "ACTIVE_FLG",
    "ACTIVE",
    "INACTIVE",
    "INACTIVE_FLG",
    "DISCONT",
    "DISCONT_FLG",
    "ITEM_STAT",
    "ITEM_STATUS",
    "STAT",
    "STATUS",
  ]);
  const dateColumn = pickColumn(imItem, [
    "LST_SAL_DAT",
    "LST_SOLD_DAT",
    "LST_SALE_DAT",
    "LST_RECV_DAT",
    "LST_PUR_DAT",
    "LST_MAINT_DT",
    "LST_UPD_DAT",
    "RS_UTC_DT",
  ]);
  const keepPredicates = [
    ...(statusColumn ? [itemStatusImportPredicate(itemAlias, statusColumn)] : []),
    ...(dateColumn ? [`${itemAlias}.[${dateColumn}] >= '__CP_IMPORT_SINCE__'`] : []),
    ...counterpointItemActivityPredicates(entries, itemAlias, locId),
  ];
  return keepPredicates.length > 0 ? `${base} AND (${keepPredicates.join(" OR ")})` : base;
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
  const itemScope = buildCounterpointItemScopePredicate(entries, "i", locId);
  return `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS item_no, ${descrExpr} AS descr, ${longExpr} AS long_descr, ${categExpr} AS categ_cod, ${vendExpr} AS vend_no, ${gridExpr} AS is_grd, ${prc1} AS prc_1, ${prc2} AS prc_2, ${prc3} AS prc_3, ${invCostSql} AS lst_cost, ${barcodeSelect} FROM IM_ITEM i ${tail} WHERE ${itemScope} ORDER BY i.ITEM_NO`.replace(
    /\s+/g,
    " ",
  );
}

function buildFlexMaxInventorySql(invCostCol, locId, entries) {
  const locEsc = escapeSqlStringLiteral(locId);
  const imInv = entries ? columnSet(entries, "IM_INV") : null;
  const imCell = entries ? columnSet(entries, "IM_INV_CELL") : null;
  let costField = invCostCol;
  if (imInv && !imInv.has(invCostCol)) {
    costField = imInv.has("LST_COST") ? "LST_COST" : imInv.has("AVG_COST") ? "AVG_COST" : imInv.has("LAST_COST") ? "LAST_COST" : null;
  }
  const locFilter = imInv?.has("LOC_ID") ? ` AND i.LOC_ID = N'${locEsc}'` : "";
  const cellLocFilter = imCell?.has("LOC_ID") ? ` AND c.LOC_ID = N'${locEsc}'` : "";
  const parentCost = costField ? `i.${costField}` : "CAST(NULL AS DECIMAL(18,4))";
  const imItem = entries ? columnSet(entries, "IM_ITEM") : null;
  const itemJoin = imItem?.has("ITEM_NO") ? " INNER JOIN IM_ITEM item ON item.ITEM_NO = i.ITEM_NO" : "";
  const itemScope = imItem?.has("ITEM_NO")
    ? buildCounterpointItemScopePredicate(entries, "item", locId)
    : "i.ITEM_NO IS NOT NULL";
  const parentSql = `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS sku, CAST(i.QTY_ON_HND AS INT) AS stock_on_hand, RTRIM(LTRIM(i.ITEM_NO)) AS counterpoint_item_key, ${parentCost} AS last_cost FROM IM_INV i${itemJoin} WHERE ${itemScope}${locFilter}`;
  if (!imCell?.has("ITEM_NO") || !imCell.has("QTY_ON_HND")) {
    return parentSql;
  }
  const dim1 = pickColumn(imCell, ["DIM_1_UPR", "DIM_1_VAL", "DIM_1", "GRID_1_VAL"]);
  const dim2 = pickColumn(imCell, ["DIM_2_UPR", "DIM_2_VAL", "DIM_2", "GRID_2_VAL"]);
  const dim3 = pickColumn(imCell, ["DIM_3_UPR", "DIM_3_VAL", "DIM_3", "GRID_3_VAL"]);
  const keyExpr = matrixKeySql("c", [dim1, dim2, dim3]);
  const cellCostJoin = imInv?.has("ITEM_NO")
    ? ` LEFT JOIN IM_INV inv ON inv.ITEM_NO = c.ITEM_NO${imInv.has("LOC_ID") && imCell.has("LOC_ID") ? " AND inv.LOC_ID = c.LOC_ID" : ""}`
    : "";
  const costExpr = imInv?.has(costField) ? `inv.${costField}` : "CAST(NULL AS DECIMAL(18,4))";
  const cellItemJoin = imItem?.has("ITEM_NO") ? " INNER JOIN IM_ITEM item ON item.ITEM_NO = c.ITEM_NO" : "";
  const cellItemScope = imItem?.has("ITEM_NO")
    ? buildCounterpointItemScopePredicate(entries, "item", locId)
    : "c.ITEM_NO IS NOT NULL";
  const cellSql = `SELECT ${keyExpr} AS sku, CAST(c.QTY_ON_HND AS INT) AS stock_on_hand, ${keyExpr} AS counterpoint_item_key, ${costExpr} AS last_cost FROM IM_INV_CELL c${cellItemJoin}${cellCostJoin} WHERE ${cellItemScope}${cellLocFilter}`;
  return `${parentSql} UNION ALL ${cellSql}`;
}

function pickColumn(set, candidates) {
  return candidates.find((c) => set?.has(c)) ?? null;
}

function sqlText(alias, set, candidates, outputName, width = 64) {
  const c = pickColumn(set, candidates);
  return c
    ? `RTRIM(LTRIM(CAST(${alias}.[${c}] AS NVARCHAR(${width})))) AS ${outputName}`
    : `CAST(NULL AS NVARCHAR(${width})) AS ${outputName}`;
}

function sqlNumber(alias, set, candidates, outputName, fallback = "CAST(NULL AS DECIMAL(18,4))") {
  const c = pickColumn(set, candidates);
  return c ? `${alias}.[${c}] AS ${outputName}` : `${fallback} AS ${outputName}`;
}

function uniquePresentColumns(set, candidates) {
  const seen = new Set();
  const cols = [];
  for (const candidate of candidates) {
    if (!candidate || !set?.has(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    cols.push(candidate);
  }
  return cols;
}

function ticketIdentityExpr(alias, column) {
  const isDate = /(DAT|DATE|_DT|DT)$/i.test(String(column ?? ""));
  const expr = isDate
    ? `CONVERT(NVARCHAR(30), ${alias}.[${column}], 126)`
    : `CONVERT(NVARCHAR(128), ${alias}.[${column}])`;
  return `ISNULL(RTRIM(LTRIM(${expr})), N'')`;
}

function ticketIdentityColumns(headerSet, ticketNumberColumn, ticketDateColumn) {
  const cols = uniquePresentColumns(headerSet, [
    "STR_ID",
    "STA_ID",
    "DRW_ID",
    "DRAWER_ID",
    ticketDateColumn,
    "BUS_DAT",
    "TKT_DT",
    "DOC_DT",
    ticketNumberColumn,
    "TKT_NO",
    "DOC_NO",
    "DOC_ID",
  ]);
  return cols.length > 0 ? cols : ticketNumberColumn ? [ticketNumberColumn] : [];
}

function ticketRefSql(alias, headerSet, columns, outputName = "ticket_ref") {
  const cols = columns.filter((column) => headerSet?.has(column));
  if (cols.length === 0) return `CAST(NULL AS NVARCHAR(512)) AS ${outputName}`;
  const parts = [];
  for (const column of cols) {
    if (parts.length > 0) parts.push("N'|'");
    parts.push(ticketIdentityExpr(alias, column));
  }
  return `CONCAT(${parts.join(", ")}) AS ${outputName}`;
}

function ticketJoinPairs(headerSet, childSet, fallbackHeaderColumn, fallbackChildColumn) {
  const common = uniquePresentColumns(headerSet, [
    "DOC_ID",
    "STR_ID",
    "STA_ID",
    "DRW_ID",
    "DRAWER_ID",
    "BUS_DAT",
    "TKT_DT",
    "DOC_DT",
    "TKT_NO",
    "DOC_NO",
  ]).filter((column) => childSet?.has(column));
  if (common.length > 0) return common.map((column) => [column, column]);
  if (fallbackHeaderColumn && fallbackChildColumn && headerSet?.has(fallbackHeaderColumn) && childSet?.has(fallbackChildColumn)) {
    return [[fallbackHeaderColumn, fallbackChildColumn]];
  }
  return [];
}

function ticketJoinPredicate(headerAlias, childAlias, pairs) {
  return pairs.map(([headerColumn, childColumn]) => `${headerAlias}.[${headerColumn}] = ${childAlias}.[${childColumn}]`).join(" AND ");
}

function matrixKeySql(alias, dims) {
  const parts = dims.map((dim) =>
    dim
      ? `ISNULL(RTRIM(LTRIM(CONVERT(NVARCHAR(80), ${alias}.[${dim}]))), N'')`
      : "N''",
  );
  return `CONCAT(RTRIM(LTRIM(${alias}.[ITEM_NO])), N'|', ${parts[0]}, N'|', ${parts[1]}, N'|', ${parts[2]})`;
}

function matrixLabelSql(alias, dims) {
  const [d1, d2, d3] = dims;
  const part = (dim) => `RTRIM(LTRIM(CONVERT(NVARCHAR(80), ${alias}.[${dim}])))`;
  if (!d1 && !d2 && !d3) return "N''";
  return [
    d1 ? `ISNULL(${part(d1)}, N'')` : "N''",
    d2 ? `CASE WHEN ${alias}.[${d2}] IS NOT NULL THEN N' / ' + ${part(d2)} ELSE N'' END` : "N''",
    d3 ? `CASE WHEN ${alias}.[${d3}] IS NOT NULL THEN N' / ' + ${part(d3)} ELSE N'' END` : "N''",
  ].join(" + ");
}

function buildFlexCatalogCellsSql(invCostCol, locId, entries) {
  const locEsc = escapeSqlStringLiteral(locId);
  const imCell = columnSet(entries, "IM_INV_CELL");
  if (!imCell?.has("ITEM_NO")) return "";
  const imPrc = columnSet(entries, "IM_PRC");
  const imInv = columnSet(entries, "IM_INV");
  const imItem = columnSet(entries, "IM_ITEM");
  const dim1 = pickColumn(imCell, ["DIM_1_UPR", "DIM_1_VAL", "DIM_1", "GRID_1_VAL"]);
  const dim2 = pickColumn(imCell, ["DIM_2_UPR", "DIM_2_VAL", "DIM_2", "GRID_2_VAL"]);
  const dim3 = pickColumn(imCell, ["DIM_3_UPR", "DIM_3_VAL", "DIM_3", "GRID_3_VAL"]);
  const keyExpr = matrixKeySql("c", [dim1, dim2, dim3]);
  const labelExpr = matrixLabelSql("c", [dim1, dim2, dim3]);
  const prcJoin = imPrc ? " LEFT JOIN IM_PRC p ON p.ITEM_NO = c.ITEM_NO" : "";
  const invJoin = imInv
    ? ` LEFT JOIN IM_INV inv ON inv.ITEM_NO = c.ITEM_NO${imInv.has("LOC_ID") && imCell.has("LOC_ID") ? " AND inv.LOC_ID = c.LOC_ID" : ""}`
    : "";
  const prc1 = imPrc?.has("PRC_1") ? "p.PRC_1" : "CAST(NULL AS DECIMAL(18,4))";
  const prc2 = imPrc?.has("PRC_2") ? "p.PRC_2" : "CAST(NULL AS DECIMAL(18,4))";
  const prc3 = imPrc?.has("PRC_3") ? "p.PRC_3" : "CAST(NULL AS DECIMAL(18,4))";
  const costField = imInv?.has(invCostCol)
    ? invCostCol
    : pickColumn(imInv, ["LST_COST", "AVG_COST", "LAST_COST"]);
  const unitCost = costField ? `inv.${costField}` : "CAST(NULL AS DECIMAL(18,4))";
  const minQty = imCell.has("MIN_QTY") ? "CAST(c.MIN_QTY AS INT)" : "CAST(NULL AS INT)";
  const qty = imCell.has("QTY_ON_HND") ? "CAST(c.QTY_ON_HND AS INT)" : "CAST(NULL AS INT)";
  const locFilter = imCell.has("LOC_ID") ? ` AND c.LOC_ID = N'${locEsc}'` : "";
  const itemJoin = imItem?.has("ITEM_NO") ? " INNER JOIN IM_ITEM item ON item.ITEM_NO = c.ITEM_NO" : "";
  const itemScope = imItem?.has("ITEM_NO")
    ? buildCounterpointItemScopePredicate(entries, "item", locId)
    : "c.ITEM_NO IS NOT NULL";
  return `SELECT RTRIM(LTRIM(c.ITEM_NO)) AS parent_item_no, ${keyExpr} AS counterpoint_item_key, ${keyExpr} AS sku, ${labelExpr} AS variation_label, ${qty} AS stock_on_hand, ${minQty} AS min_qty, ${prc1} AS retail_price, ${prc2} AS prc_2, ${prc3} AS prc_3, ${unitCost} AS unit_cost, CAST(NULL AS NVARCHAR(50)) AS barcode FROM IM_INV_CELL c${itemJoin}${prcJoin}${invJoin} WHERE ${itemScope}${locFilter}`;
}

function buildSchemaGeneratedSql(entries, { invCost, customerPts, locId }) {
  const sqlMap = {};
  const changes = [];
  const locEsc = escapeSqlStringLiteral(locId);
  const set = (name) => columnSet(entries, name);

  const syUsr = set("SY_USR");
  if (syUsr?.has("USR_ID")) {
    sqlMap.users = `SELECT ${sqlText("u", syUsr, ["USR_ID"], "usr_id")}, ${sqlText("u", syUsr, ["NAM", "NAME"], "nam", 255)}, ${sqlText("u", syUsr, ["EMAIL_ADRS_1", "EMAIL"], "email_adrs", 255)}, ${sqlText("u", syUsr, ["SEC_COD", "USR_GRP_ID"], "usr_grp_id", 64)}, ${sqlText("u", syUsr, ["STAT", "STATUS"], "status", 32)} FROM SY_USR u ORDER BY u.[USR_ID]`;
    changes.push("SY_USR staff users enabled");
  }

  const salesRep = set("PS_SLS_REP");
  if (salesRep?.has("SLS_REP")) {
    sqlMap.sales_reps = `SELECT ${sqlText("r", salesRep, ["SLS_REP"], "sls_rep")}, ${sqlText("r", salesRep, ["NAM", "NAME"], "nam", 255)}, ${sqlNumber("r", salesRep, ["COMMIS_PCT"], "commis_pct")} FROM PS_SLS_REP r ORDER BY r.[SLS_REP]`;
    changes.push("PS_SLS_REP sales reps enabled");
  }

  const buyers = set("PO_BUYER");
  const buyerId = pickColumn(buyers, ["BUYER_ID", "BUYER"]);
  if (buyers && buyerId) {
    sqlMap.buyers = `SELECT ${sqlText("b", buyers, [buyerId], "buyer_id")}, ${sqlText("b", buyers, ["NAM", "NAME"], "nam", 255)} FROM PO_BUYER b ORDER BY b.[${buyerId}]`;
    changes.push("PO_BUYER buyers enabled");
  }

  const poVend = set("PO_VEND");
  if (poVend?.has("VEND_NO")) {
    sqlMap.vendors_fast_simple = `SELECT ${sqlText("v", poVend, ["VEND_NO"], "vend_no")}, ${sqlText("v", poVend, ["NAM", "NAME", "DESCR", "VEND_NAM"], "name", 255)}, ${sqlText("v", poVend, ["TERMS_COD"], "payment_terms")}, ${sqlText("v", poVend, ["PHONE_1", "PHONE"], "phone")}, ${sqlText("v", poVend, ["EMAIL_ADRS_1", "EMAIL"], "email", 255)} FROM PO_VEND v WHERE v.[VEND_NO] IS NOT NULL ORDER BY v.[VEND_NO]`;
    changes.push("PO_VEND vendors enabled");
  }

  const poVendItem = set("PO_VEND_ITEM");
  if (poVendItem?.has("VEND_NO") && poVendItem.has("ITEM_NO")) {
    const cost = pickColumn(poVendItem, ["UNIT_COST", "VEND_COST", "LST_COST", "COST", "PUR_COST"]);
    sqlMap.vend_item = `SELECT ${sqlText("vi", poVendItem, ["VEND_NO"], "vend_no")}, ${sqlText("vi", poVendItem, ["ITEM_NO"], "item_no")}, ${sqlText("vi", poVendItem, ["VEND_ITEM_NO"], "vend_item_no", 128)}, ${cost ? `vi.[${cost}]` : "CAST(NULL AS DECIMAL(18,4))"} AS vend_cost FROM PO_VEND_ITEM vi ORDER BY vi.[VEND_NO], vi.[ITEM_NO]`;
    changes.push(`PO_VEND_ITEM vendor item links enabled${cost ? ` (${cost})` : ""}`);
  }

  if (set("AR_CUST")?.has("CUST_NO")) {
    sqlMap.customers = buildFlexMaxCustomersSql(customerPts, entries);
    changes.push(`AR_CUST customers enabled; points=${customerPts}`);
  }

  const arNotes = set("AR_CUST_NOTE");
  const noteText = pickColumn(arNotes, ["NOTE_TXT", "NOTE", "TXT"]);
  if (arNotes?.has("CUST_NO") && noteText) {
    const noteId = pickColumn(arNotes, ["NOTE_ID", "SEQ_NO", "ROW_ID"]);
    const noteDate = pickColumn(arNotes, ["NOTE_DAT", "NOTE_DT", "LST_MAINT_DT", "RS_UTC_DT"]);
    sqlMap.customer_notes = `SELECT ${sqlText("n", arNotes, ["CUST_NO"], "cust_no")}, ${noteId ? `CAST(n.[${noteId}] AS NVARCHAR(64))` : "CONVERT(NVARCHAR(64), ROW_NUMBER() OVER (ORDER BY n.[CUST_NO]))"} AS note_id, ${noteDate ? `CONVERT(varchar, n.[${noteDate}], 126) + 'Z'` : "CAST(NULL AS NVARCHAR(32))"} AS note_date, n.[${noteText}] AS note_text, ${sqlText("n", arNotes, ["USR_ID"], "usr_id")} FROM AR_CUST_NOTE n`;
    changes.push("AR_CUST_NOTE customer notes enabled");
  }

  const imItemForCatalog = set("IM_ITEM");
  if (imItemForCatalog?.has("ITEM_NO") && imItemForCatalog.has("CATEG_COD")) {
    sqlMap.category_masters = set("IM_CATEG")?.has("CATEG_COD")
      ? "SELECT DISTINCT RTRIM(LTRIM(i.CATEG_COD)) AS cp_category, COALESCE(RTRIM(LTRIM(c.DESCR)), RTRIM(LTRIM(i.CATEG_COD))) AS display_name FROM IM_ITEM i LEFT JOIN IM_CATEG c ON c.CATEG_COD = i.CATEG_COD WHERE RTRIM(LTRIM(i.ITEM_NO)) <> N'' AND NULLIF(RTRIM(LTRIM(i.CATEG_COD)), N'') IS NOT NULL ORDER BY cp_category"
      : "SELECT DISTINCT RTRIM(LTRIM(i.CATEG_COD)) AS cp_category, RTRIM(LTRIM(i.CATEG_COD)) AS display_name FROM IM_ITEM i WHERE RTRIM(LTRIM(i.ITEM_NO)) <> N'' AND NULLIF(RTRIM(LTRIM(i.CATEG_COD)), N'') IS NOT NULL ORDER BY cp_category";
    changes.push("IM_ITEM category masters enabled");
  }

  if (imItemForCatalog?.has("ITEM_NO")) {
    sqlMap.catalog = buildFlexMaxCatalogSql(invCost, locId, entries);
    changes.push("IM_ITEM catalog enabled");
  }

  if (set("IM_INV")?.has("ITEM_NO")) {
    sqlMap.inventory = buildFlexMaxInventorySql(invCost, locId, entries);
    changes.push(`IM_INV inventory enabled; LOC_ID=${locId}; cost=${invCost}`);
  }

  const cellSql = buildFlexCatalogCellsSql(invCost, locId, entries);
  if (cellSql) {
    sqlMap.catalog_cells = cellSql;
    changes.push("IM_INV_CELL matrix variants enabled");
  }

  const gift = set("SY_GFC") ?? set("SY_GFT_CERT");
  const giftTable = set("SY_GFC") ? "SY_GFC" : set("SY_GFT_CERT") ? "SY_GFT_CERT" : "";
  const giftNo = pickColumn(gift, ["GFC_NO", "GFT_CERT_NO", "CERT_NO"]);
  const giftBal = pickColumn(gift, ["CURR_AMT", "BAL", "BAL_AMT"]);
  if (giftTable && giftNo && giftBal) {
    const reason = pickColumn(gift, ["REAS_COD", "REASON_COD"]);
    sqlMap.gift_cards = `SELECT ${sqlText("g", gift, [giftNo], "gift_cert_no")}, CAST(ISNULL(g.[${giftBal}], 0) AS DECIMAL(18,2)) AS balance${reason ? `, ${sqlText("g", gift, [reason], "reason_cod")}` : ""} FROM ${giftTable} g WHERE ISNULL(g.[${giftBal}], 0) > 0`;
    changes.push(`${giftTable} gift cards enabled`);
  }

  const storeCredit = set("SY_STC");
  const storeCust = pickColumn(storeCredit, ["ORIG_CUST_NO", "CUST_NO"]);
  const storeBal = pickColumn(storeCredit, ["CURR_AMT", "BAL", "AMT"]);
  if (storeCredit && storeCust && storeBal) {
    sqlMap.store_credit = `SELECT ${sqlText("sc", storeCredit, [storeCust], "cust_no")}, CAST(ISNULL(sc.[${storeBal}], 0) AS DECIMAL(18,2)) AS balance FROM SY_STC sc WHERE CAST(ISNULL(sc.[${storeBal}], 0) AS DECIMAL(18,2)) > 0 ORDER BY sc.[${storeCust}]`;
    changes.push("SY_STC store credit opening balances enabled");
  }

  const tkt = set("PS_TKT_HIST");
  const tktNo = pickColumn(tkt, ["TKT_NO", "DOC_NO"]);
  const tktDate = pickColumn(tkt, ["BUS_DAT", "TKT_DT", "DOC_DT"]);
  const tktJoin = pickColumn(tkt, ["DOC_ID", "TKT_NO", "DOC_NO"]);
  if (tkt && tktNo && tktDate) {
    const ticketRefColumns = ticketIdentityColumns(tkt, tktNo, tktDate);
    const ticketRefSelect = ticketRefSql("h", tkt, ticketRefColumns);
    const total = pickColumn(tkt, ["TOT", "TOT_EXTD_PRC", "TKT_TOT"]);
    const due = pickColumn(tkt, ["TOT_AMT_DUE", "AMT_DUE"]);
    const configuredTypeColumn = (process.env.CP_TKT_DOC_TYP_COLUMN ?? "").trim();
    const typeColumn =
      configuredTypeColumn &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(configuredTypeColumn) &&
      tkt.has(configuredTypeColumn)
        ? configuredTypeColumn
        : pickColumn(tkt, ["TKT_TYP", "DOC_TYP", "DOC_TYPE"]);
    const typeFilter =
      typeColumn && !omitPsTktDocTypFilterEnabled()
        ? ` AND h.[${typeColumn}] = N'T'`
        : "";
    sqlMap.tickets = `SELECT ${ticketRefSelect}, ${sqlText("h", tkt, ["CUST_NO"], "cust_no")}, CONVERT(varchar, h.[${tktDate}], 126) + 'Z' AS booked_at, ${total ? `h.[${total}]` : "CAST(0 AS DECIMAL(18,2))"} AS total_price, ${total && due ? `(h.[${total}] - h.[${due}])` : total ? `h.[${total}]` : "CAST(0 AS DECIMAL(18,2))"} AS amount_paid, ${sqlText("h", tkt, ["USR_ID"], "usr_id")}, ${sqlText("h", tkt, ["SLS_REP"], "sls_rep")} FROM PS_TKT_HIST h WHERE h.[${tktDate}] >= '__CP_IMPORT_SINCE__'${typeFilter} ORDER BY h.[${tktDate}], h.[${tktNo}]`;
    changes.push(`PS_TKT_HIST tickets enabled; date=${tktDate}; key=${ticketRefColumns.join("+")}`);

    const lin = set("PS_TKT_HIST_LIN");
    const linJoin = pickColumn(lin, [tktJoin, "DOC_ID", "TKT_NO"]);
    const linJoinPairs = ticketJoinPairs(tkt, lin, tktJoin, linJoin);
    const linJoinPredicate = ticketJoinPredicate("h", "l", linJoinPairs);
    if (lin && linJoinPredicate) {
      const item = pickColumn(lin, ["ITEM_NO"]);
      const seq = pickColumn(lin, ["LIN_SEQ_NO", "SEQ_NO"]);
      const qty = pickColumn(lin, ["QTY_SOLD", "QTY"]);
      const price = pickColumn(lin, ["PRC", "PRICE"]);
      const cost = pickColumn(lin, ["UNIT_COST", "COST"]);
      const reason = pickColumn(lin, ["RET_REAS", "REAS_COD"]);
      sqlMap.ticket_lines = `SELECT ${ticketRefSelect}, ${seq ? `l.[${seq}]` : "CAST(NULL AS INT)"} AS lin_seq_no, ${sqlText("l", lin, [item], "sku")}, ${sqlText("l", lin, [item], "counterpoint_item_key")}, ${qty ? `l.[${qty}]` : "CAST(1 AS DECIMAL(18,4))"} AS quantity, ${price ? `l.[${price}]` : "CAST(0 AS DECIMAL(18,4))"} AS unit_price, ${cost ? `l.[${cost}]` : "CAST(NULL AS DECIMAL(18,4))"} AS unit_cost, CAST(NULL AS NVARCHAR(255)) AS description${reason ? `, ${sqlText("l", lin, [reason], "reason_code")}` : ""} FROM PS_TKT_HIST_LIN l INNER JOIN PS_TKT_HIST h ON ${linJoinPredicate} WHERE h.[${tktDate}] >= '__CP_IMPORT_SINCE__'${typeFilter}`;
      changes.push(`PS_TKT_HIST_LIN ticket lines enabled; join=${linJoinPairs.map(([h, l]) => `${h}=${l}`).join("+")}`);
    }

    const pmt = set("PS_TKT_HIST_PMT");
    const pmtJoin = pickColumn(pmt, [tktJoin, "DOC_ID", "TKT_NO"]);
    const pmtJoinPairs = ticketJoinPairs(tkt, pmt, tktJoin, pmtJoin);
    const pmtJoinPredicate = ticketJoinPredicate("h", "p", pmtJoinPairs);
    if (pmt && pmtJoinPredicate) {
      const payCod = pickColumn(pmt, ["PAY_COD", "PMT_TYP"]);
      const amt = pickColumn(pmt, ["AMT", "PMT_AMT"]);
      sqlMap.ticket_payments = `SELECT ${ticketRefSelect}, ${sqlText("p", pmt, [payCod], "pmt_typ")}, ${amt ? `p.[${amt}]` : "CAST(0 AS DECIMAL(18,2))"} AS amount, CAST(NULL AS NVARCHAR(32)) AS gift_cert_no FROM PS_TKT_HIST_PMT p INNER JOIN PS_TKT_HIST h ON ${pmtJoinPredicate} WHERE h.[${tktDate}] >= '__CP_IMPORT_SINCE__'${typeFilter}`;
      changes.push(`PS_TKT_HIST_PMT ticket payments enabled; join=${pmtJoinPairs.map(([h, p]) => `${h}=${p}`).join("+")}`);
    }

    const tktNote = set("PS_TKT_HIST_NOTE");
    const noteJoin = pickColumn(tktNote, [tktJoin, "DOC_ID", "TKT_NO"]);
    const noteCol = pickColumn(tktNote, ["NOTE", "NOTE_TXT", "TXT"]);
    const noteJoinPairs = ticketJoinPairs(tkt, tktNote, tktJoin, noteJoin);
    const noteJoinPredicate = ticketJoinPredicate("h", "n", noteJoinPairs);
    if (tktNote && noteJoinPredicate && noteCol) {
      sqlMap.ticket_notes = `SELECT ${ticketRefSelect}, n.[${noteCol}] AS note FROM PS_TKT_HIST_NOTE n INNER JOIN PS_TKT_HIST h ON ${noteJoinPredicate} WHERE h.[${tktDate}] >= '__CP_IMPORT_SINCE__'${typeFilter}`;
      changes.push("PS_TKT_HIST_NOTE ticket notes enabled");
    }
  }

  const psDocHdr = set("PS_DOC_HDR") ?? set("PS_DOC");
  const psDocTable = set("PS_DOC_HDR") ? "PS_DOC_HDR" : set("PS_DOC") ? "PS_DOC" : "";
  const psDocTot = set("PS_DOC_HDR_TOT");
  const psDocLin = set("PS_DOC_LIN");
  const psDocPmt = set("PS_DOC_PMT");
  const docRef = pickColumn(psDocHdr, ["DOC_ID", "DOC_NO", "TKT_NO"]);
  const docDate = pickColumn(psDocHdr, ["TKT_DT", "DOC_DT", "BUS_DAT"]);
  if (psDocTable && docRef && docDate) {
    const docRefColumns = ticketIdentityColumns(psDocHdr, docRef, docDate);
    const docRefSelect = ticketRefSql("h", psDocHdr, docRefColumns, "doc_ref");
    const docTotJoinPairs = ticketJoinPairs(psDocHdr, psDocTot, docRef, docRef);
    const docTotJoinPredicate = ticketJoinPredicate("h", "t", docTotJoinPairs);
    const hasTot = Boolean(psDocTot && docTotJoinPredicate && psDocTot.has("TOT") && psDocTot.has("TOT_TND"));
    const total = pickColumn(psDocHdr, ["TOT", "TOT_EXTD_PRC"]);
    const paid = pickColumn(psDocHdr, ["TOT_TND", "AMT_PAID", "TOT"]);
    const docStatus = pickColumn(psDocHdr, ["DOC_STAT", "DOC_STATUS", "STA_COD", "STATUS", "STAT"]);
    const docVoid = pickColumn(psDocHdr, ["VOID_FLG", "VOIDED", "VOID_FLAG", "IS_VOID"]);
    const docClosedAt = pickColumn(psDocHdr, ["CLOSE_DAT", "CLSD_DAT", "CLOSED_DAT", "CLOSED_AT", "FULFILL_DAT"]);
    const activeDocPredicates = [];
    if (docStatus) {
      activeDocPredicates.push(
        `(h.[${docStatus}] IS NULL OR UPPER(RTRIM(LTRIM(CONVERT(NVARCHAR(32), h.[${docStatus}])))) NOT IN ('C','CL','CLS','CLOSED','COMPLETE','COMPLETED','V','VOID','VOIDED'))`,
      );
    }
    if (docVoid) {
      activeDocPredicates.push(
        `(h.[${docVoid}] IS NULL OR UPPER(RTRIM(LTRIM(CONVERT(NVARCHAR(32), h.[${docVoid}])))) NOT IN ('1','Y','YES','T','TRUE'))`,
      );
    }
    if (docClosedAt) {
      activeDocPredicates.push(`h.[${docClosedAt}] IS NULL`);
    }
    const activeDocWhere = activeDocPredicates.length > 0 ? activeDocPredicates.join(" AND ") : "1=1";
    const docTotJoinForChildren = hasTot ? ` LEFT JOIN PS_DOC_HDR_TOT t ON ${docTotJoinPredicate}` : "";
    sqlMap.open_docs = hasTot
      ? `SELECT ${docRefSelect}, ${sqlText("h", psDocHdr, ["CUST_NO"], "cust_no")}, CONVERT(varchar, h.[${docDate}], 126) + 'Z' AS booked_at, ${sqlText("h", psDocHdr, ["USR_ID"], "usr_id")}, ${sqlText("h", psDocHdr, ["SLS_REP"], "sls_rep")}, ${sqlText("h", psDocHdr, ["DOC_TYP", "TKT_TYP"], "doc_typ")}, t.[TOT] AS total_price, t.[TOT_TND] AS amount_paid FROM ${psDocTable} h INNER JOIN PS_DOC_HDR_TOT t ON ${docTotJoinPredicate} WHERE ${activeDocWhere}`
      : `SELECT ${docRefSelect}, ${sqlText("h", psDocHdr, ["CUST_NO"], "cust_no")}, CONVERT(varchar, h.[${docDate}], 126) + 'Z' AS booked_at, ${sqlText("h", psDocHdr, ["USR_ID"], "usr_id")}, ${sqlText("h", psDocHdr, ["SLS_REP"], "sls_rep")}, ${sqlText("h", psDocHdr, ["DOC_TYP", "TKT_TYP"], "doc_typ")}, ${total ? `h.[${total}]` : "CAST(0 AS DECIMAL(18,2))"} AS total_price, ${paid ? `h.[${paid}]` : "CAST(0 AS DECIMAL(18,2))"} AS amount_paid FROM ${psDocTable} h WHERE ${activeDocWhere}`;
    changes.push(`${psDocTable} open documents enabled; key=${docRefColumns.join("+")}`);
    const lineDoc = pickColumn(psDocLin, [docRef, "DOC_ID", "DOC_NO", "TKT_NO"]);
    const lineJoinPairs = ticketJoinPairs(psDocHdr, psDocLin, docRef, lineDoc);
    const lineJoinPredicate = ticketJoinPredicate("h", "l", lineJoinPairs);
    if (psDocLin && lineJoinPredicate) {
      sqlMap.open_doc_lines = `SELECT ${docRefSelect}, ${sqlNumber("l", psDocLin, ["LIN_SEQ_NO", "SEQ_NO"], "lin_seq_no")}, ${sqlText("l", psDocLin, ["ITEM_NO"], "sku")}, ${sqlText("l", psDocLin, ["ITEM_NO"], "counterpoint_item_key")}, ${sqlNumber("l", psDocLin, ["QTY_ORD", "QTY_SOLD", "QTY"], "quantity", "CAST(1 AS DECIMAL(18,4))")}, ${sqlNumber("l", psDocLin, ["PRC", "PRICE"], "unit_price", "CAST(0 AS DECIMAL(18,4))")}, ${sqlNumber("l", psDocLin, ["UNIT_COST", "COST"], "unit_cost")}, CAST(NULL AS NVARCHAR(255)) AS description FROM PS_DOC_LIN l INNER JOIN ${psDocTable} h ON ${lineJoinPredicate}${docTotJoinForChildren} WHERE ${activeDocWhere}`;
      changes.push(`PS_DOC_LIN open-doc lines enabled; join=${lineJoinPairs.map(([h, l]) => `${h}=${l}`).join("+")}`);
    }
    const pmtDoc = pickColumn(psDocPmt, [docRef, "DOC_ID", "DOC_NO", "TKT_NO"]);
    const pmtJoinPairs = ticketJoinPairs(psDocHdr, psDocPmt, docRef, pmtDoc);
    const pmtJoinPredicate = ticketJoinPredicate("h", "p", pmtJoinPairs);
    if (psDocPmt && pmtJoinPredicate) {
      sqlMap.open_doc_pmt = `SELECT ${docRefSelect}, ${sqlText("p", psDocPmt, ["PAY_COD", "PMT_TYP"], "pmt_typ")}, ${sqlNumber("p", psDocPmt, ["AMT", "PMT_AMT"], "amount", "CAST(0 AS DECIMAL(18,2))")}, CAST(NULL AS NVARCHAR(32)) AS gift_cert_no FROM PS_DOC_PMT p INNER JOIN ${psDocTable} h ON ${pmtJoinPredicate}${docTotJoinForChildren} WHERE ${activeDocWhere}`;
      changes.push(`PS_DOC_PMT open-doc payments enabled; join=${pmtJoinPairs.map(([h, p]) => `${h}=${p}`).join("+")}`);
    }
  }

  const recvHeaderTable = set("PO_RECVR_HIST") ? "PO_RECVR_HIST" : set("PO_RECVR") ? "PO_RECVR" : "";
  const recvLineTable = set("PO_RECVR_HIST_LIN") ? "PO_RECVR_HIST_LIN" : set("PO_RECVR_LIN") ? "PO_RECVR_LIN" : "";
  const recvHeader = recvHeaderTable ? set(recvHeaderTable) : null;
  const recvLine = recvLineTable ? set(recvLineTable) : null;
  const recvSingleTable = !recvHeaderTable && recvLineTable ? recvLineTable : "";
  const recvSingle = recvSingleTable ? recvLine : null;
  const recvHeaderJoin = pickColumn(recvHeader, ["RECVR_NO", "RECV_NO", "DOC_ID", "PO_NO"]);
  const recvLineJoin = pickColumn(recvLine, [recvHeaderJoin, "RECVR_NO", "RECV_NO", "DOC_ID", "PO_NO"].filter(Boolean));
  const recvHeaderDate = pickColumn(recvHeader, ["RECVR_DAT", "RECV_DAT", "RECEIVED_DAT", "RECVD_DAT", "POST_DAT"]);
  const recvLineDate = pickColumn(recvLine, ["RECVR_DAT", "RECV_DAT", "RECEIVED_DAT", "RECVD_DAT", "POST_DAT"]);

  if (recvHeaderTable && recvLineTable && recvHeaderJoin && recvLineJoin && recvLine?.has("ITEM_NO") && (recvHeaderDate || recvLineDate)) {
    const dateAlias = recvHeaderDate ? "h" : "l";
    const dateCol = recvHeaderDate ?? recvLineDate;
    const vendExpr = recvHeader?.has("VEND_NO")
      ? sqlText("h", recvHeader, ["VEND_NO"], "vend_no")
      : sqlText("l", recvLine, ["VEND_NO"], "vend_no");
    const poExpr = recvHeader?.has("PO_NO")
      ? sqlText("h", recvHeader, ["PO_NO"], "po_no")
      : sqlText("l", recvLine, ["PO_NO"], "po_no");
    const recvNoExpr = recvHeader?.has(recvHeaderJoin)
      ? sqlText("h", recvHeader, [recvHeaderJoin], "recv_no")
      : sqlText("l", recvLine, [recvLineJoin], "recv_no");
    const costExpr = sqlNumber("l", recvLine, ["COST", "UNIT_COST", "LST_COST"], "unit_cost");
    sqlMap.receiving_history = `SELECT ${vendExpr}, ${sqlText("l", recvLine, ["ITEM_NO"], "item_no")}, CONVERT(varchar, ${dateAlias}.[${dateCol}], 126) + 'Z' AS recv_dat, ${costExpr}, ${sqlNumber("l", recvLine, ["QTY_RECVD", "QTY_RECV", "QTY"], "qty_recv")}, ${poExpr}, ${recvNoExpr} FROM ${recvLineTable} l INNER JOIN ${recvHeaderTable} h ON h.[${recvHeaderJoin}] = l.[${recvLineJoin}] WHERE ${dateAlias}.[${dateCol}] >= '__CP_IMPORT_SINCE__' ORDER BY ${dateAlias}.[${dateCol}]`;
    changes.push(`${recvHeaderTable}/${recvLineTable} receiving history enabled`);
  } else if (recvSingleTable && recvSingle?.has("VEND_NO") && recvSingle.has("ITEM_NO")) {
    const recvDate = pickColumn(recvSingle, ["RECVR_DAT", "RECV_DAT", "RECEIVED_DAT", "RECVD_DAT", "POST_DAT"]);
    if (recvDate) {
      sqlMap.receiving_history = `SELECT ${sqlText("r", recvSingle, ["VEND_NO"], "vend_no")}, ${sqlText("r", recvSingle, ["ITEM_NO"], "item_no")}, CONVERT(varchar, r.[${recvDate}], 126) + 'Z' AS recv_dat, ${sqlNumber("r", recvSingle, ["COST", "UNIT_COST", "LST_COST"], "unit_cost")}, ${sqlNumber("r", recvSingle, ["QTY_RECVD", "QTY_RECV", "QTY"], "qty_recv")}, ${sqlText("r", recvSingle, ["PO_NO"], "po_no")}, ${sqlText("r", recvSingle, ["RECVR_NO", "RECV_NO"], "recv_no")} FROM ${recvSingleTable} r WHERE r.[${recvDate}] >= '__CP_IMPORT_SINCE__' ORDER BY r.[${recvDate}]`;
      changes.push(`${recvSingleTable} receiving history enabled`);
    }
  }

  return { sqlMap, changes };
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
  const scope = (process.env.CP_IMPORT_SCOPE ?? "maximal").trim().toLowerCase();
  const autoOn = (process.env.CP_AUTO_SCHEMA ?? "1").trim() !== "0";
  let invCost = "LST_COST";
  let customerPts = "LOY_PTS_BAL";
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
    const arCust = columnSet(entries, "AR_CUST");
    if (arCust) {
      customerPts = ["LOY_PTS_BAL", "PTS_BAL", "LOY_PTS"].find((c) => arCust.has(c)) ?? customerPts;
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

    const bits = [`IM_INV cost=${invCost}`, `AR_CUST points=${customerPts}`];
    if (imVendCol) bits.push(`IM_ITEM vendor=${imVendCol}`);
    if (forcePoVendItem) bits.push("PO_VEND_ITEM vendor link");
    if (vendorFastOverride) bits.push("PO_VEND columns auto");
    console.info("[auto-schema]", bits.join("; "));
  }

  const locId = sqlLocId();
  const generated = schemaEntries
    ? buildSchemaGeneratedSql(schemaEntries, { invCost, customerPts, locId })
    : { sqlMap: {}, changes: [] };
  lastAutoConfigChanges = generated.changes;

  {
    const envQ = configuredSql("CP_CUSTOMERS_QUERY").trim();
    let src = envQ;
    if (!src && scope === "maximal") {
      src = schemaEntries ? generated.sqlMap.customers : SQL_MAX_CUSTOMERS;
      console.info(
        "[maximal] customers SQL" + (schemaEntries ? " (schema-flex)" : " (static fallback)"),
      );
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
    const envQ = configuredSql("CP_INVENTORY_QUERY").trim();
    let src = envQ;
    if (!src && scope === "maximal") {
      src = schemaEntries ? generated.sqlMap.inventory : sqlMaxInventory("LST_COST");
      console.info(
        "[maximal] inventory SQL LOC_ID=" + locId + (schemaEntries ? " (schema-flex)" : " (static fallback)"),
      );
    }
    if (src) {
      effectiveSql.inventory = applyCounterpointSqlCompat(expandImportSince(src));
    }
  }

  {
    const envQ = configuredSql("CP_CATALOG_QUERY").trim();
    let src = envQ;
    if (!src && scope === "maximal") {
      src = schemaEntries ? generated.sqlMap.catalog : sqlMaxCatalog("LST_COST");
      console.info(
        "[maximal] parent catalog SQL LOC_ID=" + locId + (schemaEntries ? " (schema-flex)" : " (static fallback)"),
      );
    }
    if (src) {
      effectiveSql.catalog = applyCounterpointSqlCompat(expandImportSince(src));
    }
  }

  {
    const envQ = configuredSql("CP_VEND_ITEM_QUERY").trim();
    let src = envQ;
    if (!src && scope === "maximal") src = schemaEntries ? generated.sqlMap.vend_item : SQL_MAX_VEND_ITEM;
    if (src) {
      effectiveSql.vend_item = expandImportSince(src);
    }
  }

  {
    const envQ = configuredSql("CP_CATEGORY_MASTERS_QUERY").trim();
    let src = envQ;
    if (!src && scope === "maximal") src = schemaEntries ? generated.sqlMap.category_masters : SQL_MAX_CATEGORY_MASTERS;
    if (src) {
      effectiveSql.category_masters = expandImportSince(src);
    }
  }

  for (const [key, value] of Object.entries(generated.sqlMap)) {
    if (!String(effectiveSql[key] ?? "").trim() && value) {
      effectiveSql[key] = expandImportSince(value);
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

  if (vendorFastOverride && !configuredSql("CP_VENDORS_FAST_QUERY").trim()) {
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

    // Gift cards: REAS_COD or REASON_COD injection if missing
    const syGfc = columnSet(schemaEntries, "SY_GFC");
    if (syGfc && effectiveSql.gift_cards && !effectiveSql.gift_cards.includes("reason_cod")) {
      if (syGfc.has("REAS_COD")) {
        effectiveSql.gift_cards = String(effectiveSql.gift_cards).replace(
          /\bFROM\s+SY_GFC\b/gi,
          ", RTRIM(LTRIM(REAS_COD)) AS reason_cod FROM SY_GFC"
        );
        fixBits.push("SY_GFC: injected REAS_COD AS reason_cod");
      } else if (syGfc.has("REASON_COD")) {
        effectiveSql.gift_cards = String(effectiveSql.gift_cards).replace(
          /\bFROM\s+SY_GFC\b/gi,
          ", RTRIM(LTRIM(REASON_COD)) AS reason_cod FROM SY_GFC"
        );
        fixBits.push("SY_GFC: injected REASON_COD AS reason_cod");
      }
    }

    // Open documents: DOC_ID vs DOC_NO and TKT_DT vs DOC_DT fallbacks
    const psDocHdr = columnSet(schemaEntries, "PS_DOC_HDR");
    if (psDocHdr) {
      if (!psDocHdr.has("DOC_ID") && psDocHdr.has("DOC_NO")) {
        if (effectiveSql.open_docs) {
          effectiveSql.open_docs = String(effectiveSql.open_docs)
            .replace(/\bDOC_ID\b/g, "DOC_NO")
            .replace(/h\.\[DOC_ID\]/gi, "h.[DOC_NO]")
            .replace(/h\.DOC_ID/gi, "h.DOC_NO");
        }
        if (effectiveSql.open_doc_lines) {
          effectiveSql.open_doc_lines = String(effectiveSql.open_doc_lines)
            .replace(/\bDOC_ID\b/g, "DOC_NO");
        }
        if (effectiveSql.open_doc_pmt) {
          effectiveSql.open_doc_pmt = String(effectiveSql.open_doc_pmt)
            .replace(/\bDOC_ID\b/g, "DOC_NO");
        }
        fixBits.push("PS_DOC_HDR: DOC_ID → DOC_NO");
      }
      if (!psDocHdr.has("TKT_DT") && psDocHdr.has("DOC_DT")) {
        if (effectiveSql.open_docs) {
          effectiveSql.open_docs = String(effectiveSql.open_docs)
            .replace(/\bTKT_DT\b/g, "DOC_DT")
            .replace(/h\.\[TKT_DT\]/gi, "h.[DOC_DT]")
            .replace(/h\.TKT_DT/gi, "h.DOC_DT");
        }
        fixBits.push("PS_DOC_HDR: TKT_DT → DOC_DT");
      }

      // Bypass PS_DOC_HDR_TOT join if it doesn't exist
      const psDocHdrTot = columnSet(schemaEntries, "PS_DOC_HDR_TOT");
      if (!psDocHdrTot && effectiveSql.open_docs?.includes("PS_DOC_HDR_TOT")) {
        effectiveSql.open_docs = String(effectiveSql.open_docs)
          .replace(/t\.\[TOT\]/gi, "h.[TOT]")
          .replace(/t\.\[TOT_TND\]/gi, "h.[TOT_TND]")
          .replace(/t\.TOT_TND/gi, "h.TOT_TND")
          .replace(/t\.TOT/gi, "h.TOT")
          .replace(/INNER\s+JOIN\s+PS_DOC_HDR_TOT\s+t\s+ON\s+h\.\[DOC_ID\]\s*=\s*t\.\[DOC_ID\]/gi, "")
          .replace(/INNER\s+JOIN\s+PS_DOC_HDR_TOT\s+t\s+ON\s+h\.DOC_ID\s*=\s*t\.DOC_ID/gi, "")
          .replace(/INNER\s+JOIN\s+PS_DOC_HDR_TOT\s+t\s+ON\s+h\.DOC_NO\s*=\s*t\.DOC_NO/gi, "");
        fixBits.push("PS_DOC_HDR: bypassed PS_DOC_HDR_TOT join");
      }
    }

    if (fixBits.length > 0) {
      console.info("[auto-schema] column fixups:", fixBits.join("; "));
    }
  }
}

function logCanonicalSyncOrder() {
  console.info(
    "[sync-order] Enforced pass order: staff → sales_rep_stubs (opt) → category_masters → vendors → catalog parent products + variants → vendor_items (supplier #) → inventory quantities → customers → customer_notes (opt) → tickets/sales history → receiving history → open_docs/orders → store_credit_opening (opt) → loyalty balances → gift cards.",
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

  // Allow empty query text in schema-generated mode. Optional modules such as SY_STC simply skip when absent.
  if (SYNC_STORE_CREDIT_OPENING && ALLOW_SQL_ENV_OVERRIDES && !CP_CUSTOMER_STORE_CREDIT_EXISTS_RAW.trim()) {
    warnings.push(
      "SYNC_STORE_CREDIT_OPENING=1: set CP_CUSTOMER_STORE_CREDIT_EXISTS (EXISTS body: SELECT 1 … matching c.CUST_NO with balance > 0) or customers with only store credit are skipped by CP_CUSTOMERS_QUERY.",
    );
  }
  // Allow empty queries when auto-schema is active (CP_AUTO_SCHEMA=1, the default).
  // In auto-schema mode the engine generates SQL at runtime from INFORMATION_SCHEMA,
  // so queries are legitimately empty at validation time.
  // When auto-schema is explicitly disabled (CP_AUTO_SCHEMA=0), restore full validation
  // so manual-SQL mode gets clear startup errors instead of silent empty syncs.
  const allowEmptyQueries = (process.env.CP_AUTO_SCHEMA ?? "1").trim() !== "0";

  if (SYNC_OPEN_DOCS && !String(effectiveSql.open_docs ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_OPEN_DOCS=1 requires a non-empty CP_OPEN_DOCS_QUERY.");
  }
  if (SYNC_TICKETS && !String(effectiveSql.tickets ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_TICKETS=1 requires a non-empty CP_TICKETS_QUERY.");
  }
  if (SYNC_CATEGORY_MASTERS && !String(effectiveSql.category_masters ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_CATEGORY_MASTERS=1 requires a non-empty CP_CATEGORY_MASTERS_QUERY (set SYNC_CATEGORY_MASTERS=0 to skip).");
  }
  if (SYNC_CATALOG && !String(effectiveSql.catalog ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_CATALOG=1 requires a non-empty CP_CATALOG_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_CUSTOMERS && !String(effectiveSql.customers ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_CUSTOMERS=1 requires a non-empty CP_CUSTOMERS_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_VENDORS && SYNC_VENDORS_FILTERED && !String(effectiveSql.vendors_filtered ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_VENDORS_FILTERED=1 requires a non-empty CP_VENDORS_QUERY.");
  }
  if (SYNC_INVENTORY && !String(effectiveSql.inventory ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_INVENTORY=1 requires a non-empty CP_INVENTORY_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_VENDOR_ITEMS && !String(effectiveSql.vend_item ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_VENDOR_ITEMS=1 requires a non-empty CP_VEND_ITEM_QUERY (or CP_IMPORT_SCOPE=maximal).");
  }
  if (SYNC_CUSTOMER_NOTES && !String(effectiveSql.customer_notes ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_CUSTOMER_NOTES=1 requires a non-empty CP_CUSTOMER_NOTES_QUERY.");
  }
  if (SYNC_LOYALTY_HIST && !String(effectiveSql.loyalty ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_LOYALTY_HIST=1 requires a non-empty CP_LOYALTY_HIST_QUERY.");
  }
  if (SYNC_GIFT_CARDS && !String(effectiveSql.gift_cards ?? "").trim() && !allowEmptyQueries) {
    errors.push("SYNC_GIFT_CARDS=1 requires a non-empty CP_GIFT_CARDS_QUERY.");
  }

  if (
    SYNC_STAFF &&
    !String(effectiveSql.users ?? "").trim() &&
    !String(effectiveSql.sales_reps ?? "").trim() &&
    !String(effectiveSql.buyers ?? "").trim() &&
    !allowEmptyQueries
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
  "PS_TKT_HIST_NOTE",
  "PS_TKT_HIST_CELL",
  "PS_TKT_HIST_LIN_CELL",
  "PS_TKT_HIST_GFT",
  "SY_GFC",
  "SY_GFC_HIST",
  "SY_GFT_CERT",
  "SY_GFT_CERT_HIST",
  "SY_STC",
  "PS_LOY_PTS_HIST",
  "PS_DOC",
  "PS_DOC_HDR",
  "PS_DOC_HDR_TOT",
  "PS_DOC_LIN",
  "PS_DOC_PMT",
  "PO_RECVR",
  "PO_RECVR_LIN",
  "PO_RECVR_HIST",
  "PO_RECVR_HIST_LIN",
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
  for (let attempt = 0; attempt < ROS_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      await waitForRosRequestSlot();
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
        if (res.status === 401) {
          const rosMessage = String(json?.error ?? text ?? "").slice(0, 300);
          lastErr = new Error(
            `ROS 401: invalid or missing Counterpoint sync token for ${ROS_BASE_URL}. Confirm the bridge COUNTERPOINT_SYNC_TOKEN exactly matches Settings > Integrations > Counterpoint, and that ROS_BASE_URL points at the correct Main Hub. ROS said: ${rosMessage}`,
          );
        } else {
          lastErr = new Error(`ROS ${res.status}: ${text.slice(0, 500)}`);
        }
        if (res.status === 429 && attempt + 1 < ROS_FETCH_MAX_ATTEMPTS) {
          const waitMs = retryAfterMs(res);
          console.warn(
            `[ros] rate limited by Main Hub (${method} ${urlPath}); waiting ${Math.ceil(waitMs / 1000)}s before retry ${attempt + 2}/${ROS_FETCH_MAX_ATTEMPTS}.`,
          );
          await delay(waitMs);
          continue;
        }
      } else {
        return json;
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt + 1 < ROS_FETCH_MAX_ATTEMPTS) {
      await delay(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

async function rosGetHealth() {
  return rosFetch("/api/sync/counterpoint/health", undefined, "GET");
}

/** Startup: fails if health unreachable. */
async function refreshRosStagingFromHealth() {
  const h = await rosGetHealth();
  rosStagingEnabled = IMPORT_FIRST_MODE ? false : h.counterpoint_staging_enabled === true;
  return h;
}

async function refreshRosStagingFromHealthSilent() {
  try {
    const h = await rosGetHealth();
    rosStagingEnabled = IMPORT_FIRST_MODE ? false : h.counterpoint_staging_enabled === true;
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
  if (DRY_RUN_MODE) {
    let count = 0;
    let preview = "";
    if (Array.isArray(body)) {
      count = body.length;
      if (count > 0) {
        preview = JSON.stringify(body[0]);
      }
    } else if (body && Array.isArray(body.rows)) {
      count = body.rows.length;
      if (count > 0) {
        preview = JSON.stringify(body.rows[0]);
      }
    } else if (body) {
      count = 1;
      preview = JSON.stringify(body);
    }
    console.info(`[dry-run] Would post entity "${entityKey}" with ${count} records. Preview: ${preview.slice(0, 150)}...`);
    return { success: true, count, dryRun: true };
  }
  requireImportFirstIngestMode();
  const hdr = bridgeIngestHeaders();
  const directUrl = `/api/sync/counterpoint/${pathSeg}`;
  const importBatchBody = {
    entity: entityKey,
    payload: body,
    import_run_id: activeImportRunId,
  };
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
        return IMPORT_FIRST_MODE
          ? await rosFetch("/api/sync/counterpoint/import-batch", importBatchBody, "POST", hdr)
          : await rosFetch(directUrl, body, "POST", hdr);
      }
      throw e;
    }
  }
  return IMPORT_FIRST_MODE
    ? await rosFetch("/api/sync/counterpoint/import-batch", importBatchBody, "POST", hdr)
    : await rosFetch(directUrl, body, "POST", hdr);
}

function stripTrailingOrderBy(sqlText) {
  const body = String(sqlText ?? "").trim().replace(/;\s*$/u, "");
  const trailingOrderBy = findTopLevelTrailingOrderBy(body);
  return trailingOrderBy >= 0 ? body.slice(0, trailingOrderBy).trimEnd() : body;
}

function isSqlWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch ?? "");
}

function findTopLevelTrailingOrderBy(sqlText) {
  const q = String(sqlText ?? "");
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBracketIdentifier = false;
  let lineComment = false;
  let blockComment = false;
  let lastTopLevelOrderBy = -1;

  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    const next = q[i + 1];

    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        i += 1;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (inBracketIdentifier) {
      if (ch === "]") inBracketIdentifier = false;
      continue;
    }

    if (ch === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "[") {
      inBracketIdentifier = true;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;

    const maybeOrder = q.slice(i, i + 5);
    if (
      maybeOrder.toUpperCase() === "ORDER" &&
      !isSqlWordChar(q[i - 1]) &&
      !isSqlWordChar(q[i + 5])
    ) {
      let j = i + 5;
      while (/\s/.test(q[j] ?? "")) j += 1;
      if (
        q.slice(j, j + 2).toUpperCase() === "BY" &&
        !isSqlWordChar(q[j - 1]) &&
        !isSqlWordChar(q[j + 2])
      ) {
        lastTopLevelOrderBy = i;
      }
    }
  }

  return lastTopLevelOrderBy;
}

function sourceCountSql(sqlText, options = {}) {
  const body = stripTrailingOrderBy(sqlText);
  if (!body) return "";
  const distinctColumn = options.distinctColumn;
  if (distinctColumn) {
    return `SELECT COUNT_BIG(DISTINCT NULLIF(RTRIM(LTRIM(CONVERT(NVARCHAR(512), [${distinctColumn}]))), N'')) AS source_count FROM (${body}) AS cp_source_count`;
  }
  return `SELECT COUNT_BIG(1) AS source_count FROM (${body}) AS cp_source_count`;
}

async function countCounterpointSourceRows(pool, probe) {
  const queryKey = probe.queryKey;
  const sqlText = String(effectiveSql[queryKey] ?? "").trim();
  if (!sqlText) {
    return {
      entity_key: probe.entityKey,
      label: probe.label,
      source_count: 0,
      query_key: queryKey,
      required: probe.required === true,
      suspicious_min_count: probe.suspiciousMinCount,
      status: "missing_mapping",
      message: `Bridge did not generate a SQL mapping for ${probe.label}.`,
    };
  }
  try {
    const result = await pool.request().query(sourceCountSql(sqlText, probe));
    const first = normalizeRowKeys((result.recordset ?? [])[0] ?? {});
    const sourceCount = Number(first.source_count ?? first[""] ?? 0);
    return {
      entity_key: probe.entityKey,
      label: probe.label,
      source_count: Number.isFinite(sourceCount) ? sourceCount : 0,
      query_key: queryKey,
      required: probe.required === true,
      suspicious_min_count: probe.suspiciousMinCount,
      status: "ok",
    };
  } catch (err) {
    return {
      entity_key: probe.entityKey,
      label: probe.label,
      source_count: 0,
      query_key: queryKey,
      required: probe.required === true,
      suspicious_min_count: probe.suspiciousMinCount,
      status: probe.required === true ? "blocked" : "warning",
      message: `Source-count query failed for ${probe.label}: ${err?.message ?? err}`,
    };
  }
}

function importFirstProbePlan() {
  return [
    {
      entityKey: "counterpoint_categories",
      label: "Counterpoint categories by name",
      queryKey: "category_masters",
      required: true,
    },
    {
      entityKey: "counterpoint_vendors",
      label: "Counterpoint vendors",
      queryKey: SYNC_VENDORS_FILTERED ? "vendors_filtered" : "vendors_fast_simple",
      required: true,
    },
    {
      entityKey: "catalog_products",
      label: "Catalog parent products",
      queryKey: "catalog",
      required: true,
      distinctColumn: "item_no",
    },
    {
      entityKey: "catalog_variants",
      label: "Catalog variants/SKUs",
      queryKey: String(effectiveSql.catalog_cells ?? "").trim() ? "catalog_cells" : "catalog",
      required: true,
    },
    { entityKey: "inventory_quantity_rows", label: "Inventory quantity rows", queryKey: "inventory", required: true },
    { entityKey: "customers", label: "Counterpoint customers", queryKey: "customers", required: true },
    {
      entityKey: "tickets",
      label: "Closed ticket history",
      queryKey: "tickets",
      required: true,
      suspiciousMinCount: 1000,
    },
    { entityKey: "ticket_lines", label: "Closed ticket lines", queryKey: "ticket_lines", required: true },
    { entityKey: "ticket_payments", label: "Closed ticket payments", queryKey: "ticket_payments", required: false },
    { entityKey: "receiving_history", label: "Receiving/movement history", queryKey: "receiving_history", required: false },
    {
      entityKey: "open_docs",
      label: "Open docs/unfulfilled obligations",
      queryKey: "open_docs",
      required: true,
      suspiciousMinCount: 100,
    },
    { entityKey: "open_doc_lines", label: "Open-doc lines", queryKey: "open_doc_lines", required: true },
    { entityKey: "open_doc_payments", label: "Open-doc deposits/payments", queryKey: "open_doc_pmt", required: false },
    { entityKey: "loyalty_points", label: "Customer loyalty balances", queryKey: "customers", required: true },
    { entityKey: "gift_cards", label: "Gift card current balances", queryKey: "gift_cards", required: true },
    { entityKey: "store_credit_opening", label: "Store credit opening balances", queryKey: "store_credit", required: false },
  ];
}

function bridgeStartupIssuesForImportFirst() {
  const issues = [];
  if (CP_IMPORT_SINCE !== REQUIRED_CP_IMPORT_SINCE) {
    issues.push(`CP_IMPORT_SINCE must be ${REQUIRED_CP_IMPORT_SINCE}; received ${CP_IMPORT_SINCE}.`);
  }
  if (!IMPORT_FIRST_MODE) {
    issues.push("CP_IMPORT_FIRST_MODE is disabled.");
  }
  if (!SYNC_CUSTOMERS) issues.push("SYNC_CUSTOMERS is disabled.");
  if (!SYNC_CATALOG) issues.push("SYNC_CATALOG is disabled.");
  if (!SYNC_INVENTORY) issues.push("SYNC_INVENTORY is disabled.");
  if (!SYNC_TICKETS) issues.push("SYNC_TICKETS is disabled.");
  if (!SYNC_OPEN_DOCS) issues.push("SYNC_OPEN_DOCS is disabled.");
  if (!SYNC_GIFT_CARDS) issues.push("SYNC_GIFT_CARDS is disabled.");
  return issues;
}

async function runImportFirstSourcePreflight(pool) {
  if (!IMPORT_FIRST_MODE) return null;
  if (DRY_RUN_MODE) {
    console.info("[preflight] Dry run mode: source-count SQL can run, but ROS import preflight post is skipped.");
    return null;
  }

  console.info("[preflight] Import-first source-count preflight starting...");
  const counts = [];
  for (const probe of importFirstProbePlan()) {
    const row = await countCounterpointSourceRows(pool, probe);
    counts.push(row);
    console.info(
      `[preflight] ${row.entity_key}: ${row.source_count} (${row.status}${row.message ? ` - ${row.message}` : ""})`,
    );
  }

  const sourceFingerprint = crypto
    .createHash("sha256")
    .update(
      counts
        .map((row) => `${row.entity_key}:${row.source_count}:${row.status}:${row.query_key ?? ""}`)
        .join("|"),
    )
    .digest("hex");

  const summary = await rosFetch(
    "/api/sync/counterpoint/preflight",
    {
      history_start: CP_IMPORT_SINCE,
      bridge_hostname: bridgeHostnameCached || os.hostname(),
      bridge_version: BRIDGE_VERSION,
      ros_base_url: ROS_BASE_URL,
      source_fingerprint: sourceFingerprint,
      import_first: IMPORT_FIRST_MODE,
      staging_enabled: rosStagingEnabled,
      dry_run: DRY_RUN_MODE,
      startup_issues: bridgeStartupIssuesForImportFirst(),
      counts,
      metadata: {
        required_history_start: REQUIRED_CP_IMPORT_SINCE,
        allow_import_with_preflight_blockers: ALLOW_IMPORT_WITH_PREFLIGHT_BLOCKERS,
      },
    },
    "POST",
    bridgeIngestHeaders(),
  );

  if (summary?.preflight_passed !== true) {
    const blockers = Array.isArray(summary?.blockers) ? summary.blockers : [];
    const blockerText = blockers
      .slice(0, 8)
      .map((b) => `${b.entity_key ? `${b.entity_key}: ` : ""}${b.message ?? b.reason_code ?? "blocked"}`)
      .join(" | ");
    const message = blockerText || "Bridge source-count preflight failed.";
    if (!ALLOW_IMPORT_WITH_PREFLIGHT_BLOCKERS) {
      throw new Error(`[preflight] Import blocked: ${message}`);
    }
    console.warn(`[preflight] Import blockers ignored by CP_ALLOW_IMPORT_WITH_PREFLIGHT_BLOCKERS=1: ${message}`);
  } else {
    console.info(`[preflight] Import-first source-count preflight passed (${summary.import_run_id}).`);
  }

  return summary;
}

async function startImportFirstRun(preflightSummary) {
  if (!IMPORT_FIRST_MODE || DRY_RUN_MODE) return null;
  const summary = await rosFetch(
    "/api/sync/counterpoint/import-run/start",
    {
      preflight_import_run_id: preflightSummary?.import_run_id ?? null,
      run_kind: process.env.CP_IMPORT_RUN_KIND || "rehearsal",
      bridge_hostname: bridgeHostnameCached || os.hostname(),
      bridge_version: BRIDGE_VERSION,
      ros_base_url: ROS_BASE_URL,
      source_fingerprint: preflightSummary?.source_fingerprint ?? null,
    },
    "POST",
    bridgeIngestHeaders(),
  );
  activeImportRunId = summary?.import_run_id ?? null;
  if (!activeImportRunId) {
    throw new Error("[import-run] ROS did not return an import_run_id.");
  }
  console.info(`[import-run] Started ${summary.run_kind ?? "rehearsal"} import run ${activeImportRunId}.`);
  return summary;
}

async function completeImportFirstRun({ failed = false, errorMessage = null, totals = {} } = {}) {
  if (!activeImportRunId || DRY_RUN_MODE) return null;
  try {
    const summary = await rosFetch(
      "/api/sync/counterpoint/import-run/complete",
      {
        import_run_id: activeImportRunId,
        failed,
        error_message: errorMessage,
        totals,
      },
      "POST",
      bridgeIngestHeaders(),
    );
    console.info(`[import-run] ${failed ? "Failed" : "Completed"} import run ${activeImportRunId}.`);
    return summary;
  } finally {
    activeImportRunId = null;
  }
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function normalizeCsvHeader(header) {
  return String(header ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();
}

function preflightArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

function parseIntegerQuantity(raw) {
  const n = Number.parseFloat(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function csvPreflightInventoryRow(row) {
  const out = {
    sku: String(row.sku ?? "").trim(),
    stock_on_hand: parseIntegerQuantity(row.inventory_main_outlet),
  };
  const unitCost = String(row.supply_price ?? "").trim();
  if (unitCost) out.unit_cost = unitCost;
  return out;
}

function csvPreflightAliasRow(row) {
  return {
    sku: String(row.sku ?? "").trim(),
    family_key: String(row.tags ?? "").trim() || null,
    option_values: [
      row.variant_option_one_value,
      row.variant_option_two_value,
      row.variant_option_three_value,
    ].map((value) => String(value ?? "").trim()).filter(Boolean),
  };
}

function csvNormalizationPreviewRow(row, lineNumber, rawLine = null) {
  return {
    sku: String(row.sku ?? "").trim(),
    handle: String(row.handle ?? "").trim() || null,
    name: String(row.name ?? "").trim() || null,
    product_category: String(row.product_category ?? "").trim() || null,
    supplier_name: String(row.supplier_name ?? "").trim() || null,
    supplier_code: String(row.supplier_code ?? "").trim() || null,
    brand_name: String(row.brand_name ?? "").trim() || null,
    tags: String(row.tags ?? "").trim() || null,
    variant_options: [
      [row.variant_option_one_name, row.variant_option_one_value],
      [row.variant_option_two_name, row.variant_option_two_value],
      [row.variant_option_three_name, row.variant_option_three_value],
    ]
      .map(([name, value]) => ({
        name: String(name ?? "").trim() || null,
        value: String(value ?? "").trim() || null,
      }))
      .filter((option) => option.value),
    source_row_number: lineNumber,
    source_row_hash: sha256Hex(rawLine ?? JSON.stringify(row)),
    raw_row: row,
  };
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function loadInventoryPreflightCsv(csvPath) {
  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  const rows = [];
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    if (lineNumber === 1) {
      headers = parseCsvLine(line).map(normalizeCsvHeader);
      continue;
    }
    if (!headers) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? "";
    });
    rows.push(csvPreflightInventoryRow(row));
  }

  if (!headers) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }
  for (const required of ["sku", "inventory_main_outlet", "supply_price"]) {
    if (!headers.includes(required)) {
      throw new Error(`CSV missing required column: ${required}`);
    }
  }

  const unavailableItemKeyReason = headers.includes("counterpoint_item_key")
    ? null
    : "No stable counterpoint_item_key column found; item-key validation is unavailable for this CSV.";

  return { rows, headers, unavailableItemKeyReason };
}

async function loadAliasPreflightCsv(csvPath) {
  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  const rows = [];
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    if (lineNumber === 1) {
      headers = parseCsvLine(line).map(normalizeCsvHeader);
      continue;
    }
    if (!headers) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? "";
    });
    rows.push({
      ...csvPreflightAliasRow(row),
      source_row_number: lineNumber,
      source_row_hash: sha256Hex(line),
    });
  }

  if (!headers) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }
  for (const required of [
    "sku",
    "tags",
    "variant_option_one_value",
    "variant_option_two_value",
    "variant_option_three_value",
  ]) {
    if (!headers.includes(required)) {
      throw new Error(`CSV missing required column: ${required}`);
    }
  }

  return { rows, headers };
}

async function loadLightspeedNormalizationCsv(csvPath) {
  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  const rows = [];
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    if (lineNumber === 1) {
      headers = parseCsvLine(line).map(normalizeCsvHeader);
      continue;
    }
    if (!headers || line.trim() === "") continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? "";
    });
    rows.push(csvNormalizationPreviewRow(row, lineNumber, line));
  }

  if (!headers) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }
  for (const required of [
    "sku",
    "handle",
    "name",
    "product_category",
    "supplier_name",
    "supplier_code",
    "tags",
  ]) {
    if (!headers.includes(required)) {
      throw new Error(`Lightspeed CSV missing required column: ${required}`);
    }
  }

  return { rows, headers };
}

function countIssuesByType(issues) {
  const counts = {};
  for (const issue of issues ?? []) {
    const key = String(issue.issue_type ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function duplicateBskuExamples(issues) {
  return (issues ?? [])
    .filter((issue) => issue.issue_type === "duplicate_normalized_b_sku")
    .map((issue) => issue.normalized_sku)
    .filter(Boolean)
    .slice(0, 25);
}

function printInventoryPreflightReport(csvPath, payloadRows, headers, unavailableItemKeyReason, report) {
  const summary = report?.summary ?? {};
  const issueCounts = countIssuesByType(report?.issues);
  const duplicateExamples = duplicateBskuExamples(report?.issues);

  console.log("");
  console.log("Counterpoint inventory identity preflight");
  console.log(`CSV: ${csvPath}`);
  console.log(`Rows read: ${payloadRows.length}`);
  console.log("");
  console.log("Mapping used:");
  console.log("- sku <- CSV sku");
  console.log("- stock_on_hand <- CSV inventory_main_outlet");
  console.log("- unit_cost <- CSV supply_price");
  if (unavailableItemKeyReason) {
    console.log(`- counterpoint_item_key omitted (${unavailableItemKeyReason})`);
  } else if (headers.includes("counterpoint_item_key")) {
    console.log("- counterpoint_item_key <- CSV counterpoint_item_key");
  }
  console.log("");
  console.log("Preflight summary:");
  console.log(`- total rows checked: ${summary.variant_rows_checked ?? summary.total_rows ?? 0}`);
  console.log(`- duplicate B-SKU values: ${summary.duplicate_normalized_b_sku_values ?? 0}`);
  console.log(`- duplicate counterpoint item key values: ${unavailableItemKeyReason ? "unavailable" : (summary.duplicate_counterpoint_item_key_values ?? 0)}`);
  console.log(`- blank/generated/non-B SKU rows: ${summary.invalid_sku_rows ?? 0}`);
  console.log(`- SKU-to-family conflicts: ${unavailableItemKeyReason ? "unavailable" : (summary.conflicting_sku_family_values ?? 0)}`);
  console.log(`- SKU-to-counterpoint item key conflicts: ${unavailableItemKeyReason ? "unavailable" : (summary.conflicting_sku_counterpoint_item_key_values ?? 0)}`);
  console.log(`- total issues: ${summary.issue_count ?? 0}`);
  console.log(`- affected rows: ${summary.affected_row_count ?? 0}`);
  console.log("");
  console.log("Issue type counts:");
  for (const [issueType, count] of Object.entries(issueCounts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${issueType}: ${count}`);
  }
  if (duplicateExamples.length > 0) {
    console.log("");
    console.log(`Duplicate B-SKU examples: ${duplicateExamples.join(", ")}`);
  }
}

function printAliasPreflightReport(csvPath, payloadRows, report) {
  const summary = report?.summary ?? {};
  const examples = report?.examples ?? [];

  console.log("");
  console.log("Counterpoint barcode alias preflight");
  console.log(`CSV: ${csvPath}`);
  console.log(`Rows read: ${payloadRows.length}`);
  console.log("");
  console.log("Mapping used:");
  console.log("- B-SKU alias candidate <- CSV sku");
  console.log("- family_key <- CSV tags");
  console.log("- option_values <- CSV variant_option_one_value, variant_option_two_value, variant_option_three_value");
  console.log("- posts only to /api/sync/counterpoint/aliases/preflight");
  console.log("");
  console.log("Preflight summary:");
  console.log(`- total rows checked: ${summary.total_rows ?? 0}`);
  console.log(`- mappable aliases: ${summary.mappable ?? 0}`);
  console.log(`- duplicate B-SKU rows: ${summary.duplicate_b_sku ?? 0}`);
  console.log(`- ambiguous variant matches: ${summary.ambiguous_variant_match ?? 0}`);
  console.log(`- no ROS variant match: ${summary.no_ros_variant_match ?? 0}`);
  console.log(`- missing family: ${summary.missing_family ?? 0}`);
  console.log(`- invalid/non-B SKU rows: ${summary.invalid_non_b_sku ?? 0}`);
  console.log(`- existing barcode conflicts: ${summary.existing_barcode_conflict ?? 0}`);

  if (examples.length > 0) {
    console.log("");
    console.log("Examples:");
    const byClassification = new Map();
    for (const example of examples) {
      const key = String(example.classification ?? "unknown");
      if (!byClassification.has(key)) byClassification.set(key, []);
      byClassification.get(key).push(example);
    }
    for (const [classification, groupedExamples] of [...byClassification.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`- ${classification}:`);
      for (const example of groupedExamples.slice(0, 3)) {
        const parts = [
          `row ${example.row_number}`,
          example.b_sku,
          example.family_key ? `family ${example.family_key}` : null,
          example.counterpoint_item_key ? `variant ${example.counterpoint_item_key}` : null,
        ].filter(Boolean);
        console.log(`  - ${parts.join(" | ")}: ${example.message}`);
      }
    }
  }
}

function printAliasPersistReport(csvPath, payloadRows, report) {
  const summary = report?.summary ?? {};
  console.log("");
  console.log("Counterpoint barcode alias persistence");
  console.log(`CSV: ${csvPath}`);
  console.log(`Rows read: ${payloadRows.length}`);
  console.log("");
  console.log("Mapping used:");
  console.log("- B-SKU alias candidate <- CSV sku");
  console.log("- family_key <- CSV tags");
  console.log("- option_values <- CSV variant_option_one_value, variant_option_two_value, variant_option_three_value");
  console.log("- source_file_name/hash and source_row_number/hash from CSV file");
  console.log("- posts only to /api/sync/counterpoint/aliases/persist");
  console.log("");
  console.log("Persistence summary:");
  console.log(`- dry run: ${summary.dry_run ? "yes" : "no"}`);
  console.log(`- replace existing counterpoint_b_sku aliases: ${summary.replace ? "yes" : "no"}`);
  console.log(`- total rows checked: ${summary.total_rows ?? 0}`);
  console.log(`- mappable aliases: ${summary.mappable_aliases ?? 0}`);
  console.log(`- would insert aliases: ${summary.would_insert_aliases ?? 0}`);
  console.log(`- inserted aliases: ${summary.inserted_aliases ?? 0}`);
  console.log(`- deleted existing counterpoint_b_sku aliases: ${summary.deleted_existing_counterpoint_b_sku_aliases ?? 0}`);
  console.log(`- already existing identical aliases: ${summary.already_existing_identical_aliases ?? 0}`);
  console.log(`- skipped duplicate B-SKU rows: ${summary.skipped_duplicate_b_sku ?? 0}`);
  console.log(`- skipped ambiguous variant matches: ${summary.skipped_ambiguous_variant_match ?? 0}`);
  console.log(`- skipped no ROS variant match: ${summary.skipped_no_ros_variant_match ?? 0}`);
  console.log(`- skipped missing family: ${summary.skipped_missing_family ?? 0}`);
  console.log(`- skipped invalid/non-B SKU rows: ${summary.skipped_invalid_non_b_sku ?? 0}`);
  console.log(`- skipped existing barcode conflicts: ${summary.skipped_existing_barcode_conflict ?? 0}`);
  console.log(`- active alias conflicts: ${summary.conflicts ?? 0}`);
}

function printNormalizationPreviewReport(csvPath, payloadRows, report) {
  const summary = report?.summary ?? {};
  const candidates = report?.candidates ?? [];
  const excluded = report?.excluded_examples ?? [];

  console.log("");
  console.log("Counterpoint / Lightspeed normalization preview");
  console.log(`Lightspeed CSV: ${csvPath}`);
  console.log(`Rows read: ${payloadRows.length}`);
  console.log("");
  console.log("Source authority:");
  console.log(`- ${report?.source_authority ?? "Lightspeed is normalization reference only."}`);
  console.log("");
  console.log("Mapping used:");
  console.log("- match key <- active product_variant_barcode_aliases counterpoint_b_sku alias");
  console.log("- Lightspeed SKU reference <- CSV sku");
  console.log("- Lightspeed handle/group reference <- CSV handle");
  console.log("- Lightspeed product name <- CSV name");
  console.log("- Lightspeed category reference <- CSV product_category");
  console.log("- Lightspeed supplier reference <- CSV supplier_name, supplier_code");
  console.log("- Lightspeed option reference <- CSV variant_option_*_name/value");
  console.log("- excludes quantity, cost, retail price, tax, accounting, and identity fields");
  console.log("- posts only to /api/sync/counterpoint/normalization/preview");
  console.log("");
  console.log("Preview summary:");
  console.log(`- total Lightspeed rows: ${summary.total_lightspeed_rows ?? 0}`);
  console.log(`- Lightspeed B-SKU rows: ${summary.lightspeed_b_sku_rows ?? 0}`);
  console.log(`- matched aliases: ${summary.matched_aliases ?? 0}`);
  console.log(`- clean candidates suitable for AI suggestion: ${summary.clean_candidates ?? 0}`);
  console.log(`- excluded rows: ${summary.excluded_rows ?? 0}`);
  console.log(`- duplicate Lightspeed B-SKU rows: ${summary.duplicate_lightspeed_b_sku_rows ?? 0}`);
  console.log(`- invalid/non-B SKU rows: ${summary.invalid_non_b_sku_rows ?? 0}`);
  console.log(`- no active ROS alias rows: ${summary.no_active_alias_rows ?? 0}`);
  console.log(`- duplicate active alias conflict rows: ${summary.duplicate_active_alias_conflict_rows ?? 0}`);
  console.log(`- product name differences: ${summary.name_differences ?? 0}`);
  console.log(`- category differences: ${summary.category_differences ?? 0}`);
  console.log(`- supplier differences: ${summary.supplier_differences ?? 0}`);
  console.log(`- variant label/value differences: ${summary.variant_option_differences ?? 0}`);

  if (candidates.length > 0) {
    console.log("");
    console.log("Candidate examples:");
    for (const candidate of candidates.slice(0, 5)) {
      const diffs = Object.entries(candidate.differences ?? {})
        .filter(([, value]) => value)
        .map(([key]) => key)
        .join(", ") || "none";
      console.log(
        `- row ${candidate.row_number ?? "?"} | ${candidate.b_sku} | ${candidate.ros_product_name} | differences: ${diffs}`,
      );
    }
  }

  if (excluded.length > 0) {
    console.log("");
    console.log("Excluded examples:");
    for (const example of excluded.slice(0, 10)) {
      console.log(
        `- row ${example.row_number ?? "?"} | ${example.b_sku || "blank"} | ${example.reason}: ${example.message}`,
      );
    }
  }
}

function printLightspeedReferenceImportReport(csvPath, payloadRows, report) {
  const health = report?.health ?? {};
  const activeBatch = report?.active_batch ?? health?.active_batch ?? {};

  console.log("");
  console.log("Lightspeed normalization reference import");
  console.log(`Lightspeed CSV: ${csvPath}`);
  console.log(`Rows read: ${payloadRows.length}`);
  console.log("");
  console.log("Reference rules:");
  console.log("- imports Lightspeed rows as normalization reference only");
  console.log("- does not mutate products, variants, aliases, inventory, cost, price, tax, or accounting");
  console.log("- marks one Lightspeed reference batch active");
  console.log("- posts only to /api/sync/counterpoint/lightspeed-reference/import");
  console.log("");
  console.log("Import summary:");
  console.log(`- source file: ${activeBatch.source_file_name ?? "unknown"}`);
  console.log(`- replace existing reference batches: ${report?.replaced_existing_batches ? "yes" : "no"}`);
  console.log(`- inserted rows: ${report?.inserted_rows ?? 0}`);
  console.log(`- active batch row count: ${health.row_count ?? 0}`);
  console.log(`- B-SKU rows: ${health.b_sku_count ?? 0}`);
  console.log(`- duplicate B-SKU groups: ${health.duplicate_b_sku_groups ?? 0}`);
  console.log(`- latest import timestamp: ${health.latest_imported_at ?? activeBatch.imported_at ?? "none"}`);
}

async function runPreflightCommand() {
  const entity = process.argv[3];
  const csvArg = preflightArg("--csv");
  if (!["inventory", "aliases"].includes(entity) || !csvArg) {
    console.error("Usage: node index.mjs preflight inventory --csv <path>");
    console.error("   or: node index.mjs preflight aliases --csv <path>");
    process.exit(1);
  }
  if (!SYNC_TOKEN.trim()) {
    console.error("Set COUNTERPOINT_SYNC_TOKEN");
    process.exit(1);
  }

  const csvPath = path.resolve(process.cwd(), csvArg);
  bridgeHostnameCached = os.hostname();

  if (entity === "aliases") {
    const { rows } = await loadAliasPreflightCsv(csvPath);
    const report = await rosFetch(
      "/api/sync/counterpoint/aliases/preflight",
      { rows },
      "POST",
      {
        ...bridgeIngestHeaders(),
        "x-bridge-command": "preflight aliases csv",
      },
    );
    printAliasPreflightReport(csvPath, rows, report);
    return;
  }

  const { rows, headers, unavailableItemKeyReason } = await loadInventoryPreflightCsv(csvPath);
  const report = await rosFetch(
    "/api/sync/counterpoint/inventory/preflight",
    { rows },
    "POST",
    {
      ...bridgeIngestHeaders(),
      "x-bridge-command": "preflight inventory csv",
    },
  );

  printInventoryPreflightReport(csvPath, rows, headers, unavailableItemKeyReason, report);
}

async function runNormalizationCommand() {
  const action = process.argv[3];
  const csvArg = preflightArg("--lightspeed-csv");
  if (action !== "preview" || !csvArg) {
    console.error('Usage: node index.mjs normalization preview --lightspeed-csv "product-export (5).csv"');
    process.exit(1);
  }
  if (!SYNC_TOKEN.trim()) {
    console.error("Set COUNTERPOINT_SYNC_TOKEN");
    process.exit(1);
  }

  const csvPath = path.resolve(process.cwd(), csvArg);
  bridgeHostnameCached = os.hostname();
  const { rows } = await loadLightspeedNormalizationCsv(csvPath);
  const report = await rosFetch(
    "/api/sync/counterpoint/normalization/preview",
    {
      source_file_name: path.basename(csvPath),
      rows,
    },
    "POST",
    {
      ...bridgeIngestHeaders(),
      "x-bridge-command": "normalization preview lightspeed csv",
    },
  );
  printNormalizationPreviewReport(csvPath, rows, report);
}

async function runAliasesCommand() {
  const action = process.argv[3];
  const csvArg = preflightArg("--csv");
  const dryRun = process.argv.includes("--dry-run");
  const replace = process.argv.includes("--replace");
  if (action !== "persist" || !csvArg) {
    console.error("Usage: node index.mjs aliases persist --csv <path> [--replace] [--dry-run]");
    process.exit(1);
  }
  if (!SYNC_TOKEN.trim()) {
    console.error("Set COUNTERPOINT_SYNC_TOKEN");
    process.exit(1);
  }

  const csvPath = path.resolve(process.cwd(), csvArg);
  bridgeHostnameCached = os.hostname();
  const { rows } = await loadAliasPreflightCsv(csvPath);
  const report = await rosFetch(
    "/api/sync/counterpoint/aliases/persist",
    {
      source_file_name: path.basename(csvPath),
      source_file_hash: await hashFileSha256(csvPath),
      dry_run: dryRun,
      replace,
      rows,
    },
    "POST",
    {
      ...bridgeIngestHeaders(),
      "x-bridge-command": [
        "aliases persist csv",
        replace ? "replace" : null,
        dryRun ? "dry-run" : null,
      ].filter(Boolean).join(" "),
    },
  );
  printAliasPersistReport(csvPath, rows, report);
}

async function runLightspeedReferenceCommand() {
  const action = process.argv[3];
  const csvArg = preflightArg("--csv");
  const replace = process.argv.includes("--replace");
  if (action !== "import" || !csvArg) {
    console.error('Usage: node index.mjs lightspeed-reference import --csv "product-export (5).csv" [--replace]');
    process.exit(1);
  }
  if (!SYNC_TOKEN.trim()) {
    console.error("Set COUNTERPOINT_SYNC_TOKEN");
    process.exit(1);
  }

  const csvPath = path.resolve(process.cwd(), csvArg);
  bridgeHostnameCached = os.hostname();
  const { rows } = await loadLightspeedNormalizationCsv(csvPath);
  const report = await rosFetch(
    "/api/sync/counterpoint/lightspeed-reference/import",
    {
      source_file_name: path.basename(csvPath),
      source_file_hash: await hashFileSha256(csvPath),
      replace,
      rows,
    },
    "POST",
    {
      ...bridgeIngestHeaders(),
      "x-bridge-command": [
        "lightspeed reference import csv",
        replace ? "replace" : null,
      ].filter(Boolean).join(" "),
    },
  );
  printLightspeedReferenceImportReport(csvPath, rows, report);
}

async function sendHeartbeat(phase, currentEntity) {
  try {
    const resp = await rosFetch("/api/sync/counterpoint/heartbeat", {
      phase,
      current_entity: currentEntity ?? null,
      version: BRIDGE_VERSION,
      hostname: os.hostname(),
    });
    if (resp?.pending_request_id) {
        logToDashboard(`[heartbeat] Pending request found: ${resp.pending_request_id} (${resp.pending_request_entity ?? "Full"})`);
    } else {
        // Log a subtle heartbeat to show life
        if (Math.random() < 0.1) { // 10% of heartbeats to avoid spam
            logToDashboard(`[heartbeat] online (bridge ${BRIDGE_VERSION})`);
        }
    }
    return resp;
  } catch (e) {
    console.error("[heartbeat]", e.message ?? e);
    return null;
  }
}

async function signalRunStart(entity, cursor = null) {
  try {
    await rosFetch(
      "/api/sync/counterpoint/run-start",
      { entity, cursor },
      "POST",
      bridgeIngestHeaders(),
    );
  } catch (e) {
    console.warn(`[${entity}] could not reset ROS run counter before sync:`, e?.message ?? e);
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

function throwIfBatchFailures(entity, failures, postedRows, sourceRows) {
  if (failures.length === 0) return;
  const first = failures[0]?.message ?? String(failures[0] ?? "unknown error");
  throw new Error(
    `[${entity}] ${failures.length} batch post(s) failed; ${postedRows}/${sourceRows} row(s) posted. First failure: ${first}`,
  );
}

function decimalToScaledInt(value, scale = 2) {
  const raw = String(value ?? "0").trim().replace(/,/g, "");
  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] || "0");
  const frac = String(match[3] ?? "").padEnd(scale, "0").slice(0, scale);
  const factor = 10n ** BigInt(scale);
  return sign * (whole * factor + BigInt(frac || "0"));
}

function scaledIntToDecimalString(value, scale = 2) {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const factor = 10n ** BigInt(scale);
  const whole = abs / factor;
  const frac = String(abs % factor).padStart(scale, "0");
  return scale === 0 ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

function intLikeToBigInt(value) {
  if (value == null || value === "") return 0n;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.trunc(n));
}

function checksumText(value, { uppercase = false } = {}) {
  const normalized = value == null ? "" : String(value).trim();
  return uppercase ? normalized.toUpperCase() : normalized;
}

function checksumDecimal(value, scale = 4) {
  if (value == null || String(value).trim() === "") {
    return `0.${"0".repeat(scale)}`;
  }
  const cleaned = String(value).trim().replace(/[$,]/g, "");
  const negative = cleaned.startsWith("-");
  const unsigned = cleaned.replace(/^[+-]/, "");
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw.replace(/\D/g, "") || "0";
  const fracDigits = fracRaw.replace(/\D/g, "");
  const padded = `${fracDigits}${"0".repeat(scale + 1)}`;
  let scaled = BigInt(whole) * (10n ** BigInt(scale));
  scaled += BigInt(padded.slice(0, scale) || "0");
  if (Number(padded[scale] ?? "0") >= 5) scaled += 1n;
  if (negative) scaled = -scaled;
  return scaledIntToDecimalString(scaled, scale);
}

function checksumQuantity(value) {
  if (value == null || String(value).trim() === "") return "0";
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.trunc(n));
}

function checksumRows(rows) {
  const body = [...rows].sort().join("\n");
  return crypto.createHash("md5").update(body, "utf8").digest("hex");
}

function catalogPriceCostChecksumRows(row) {
  const rows = [];
  const cells = Array.isArray(row.cells) ? row.cells : [];
  if (cells.length === 0) {
    rows.push([
      checksumText(row.item_no, { uppercase: true }),
      checksumDecimal(row.retail_price),
      checksumDecimal(row.unit_cost),
      checksumDecimal(row.prc_2),
      checksumDecimal(row.prc_3),
    ].join("|"));
    return rows;
  }
  for (const cell of cells) {
    rows.push([
      checksumText(cell.counterpoint_item_key, { uppercase: true }),
      checksumDecimal(cell.retail_price ?? row.retail_price),
      checksumDecimal(cell.unit_cost ?? row.unit_cost),
      checksumDecimal(cell.prc_2),
      checksumDecimal(cell.prc_3),
    ].join("|"));
  }
  return rows;
}

function catalogCategoryVendorChecksumRow(row) {
  return [
    checksumText(row.item_no, { uppercase: true }),
    checksumText(row.category, { uppercase: true }),
    checksumText(row.vendor_no, { uppercase: true }),
  ].join("|");
}

function catalogVariantLabelChecksumRows(row) {
  const rows = [];
  const cells = Array.isArray(row.cells) ? row.cells : [];
  if (cells.length === 0) {
    rows.push([checksumText(row.item_no, { uppercase: true }), ""].join("|"));
    return rows;
  }
  for (const cell of cells) {
    rows.push([
      checksumText(cell.counterpoint_item_key, { uppercase: true }),
      checksumText(cell.variation_label),
    ].join("|"));
  }
  return rows;
}

function inventoryQuantityCostChecksumRow(row) {
  return [
    checksumText(row.counterpoint_item_key || row.sku, { uppercase: true }),
    checksumQuantity(row.stock_on_hand),
    checksumDecimal(row.unit_cost),
  ].join("|");
}

function catalogPriceCostDiagnosticRows(row) {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  if (cells.length === 0) {
    return [{
      item_no: row.item_no,
      counterpoint_item_key: row.item_no,
      sku: row.item_no,
      barcode: row.barcode,
      retail_price: row.retail_price,
      unit_cost: row.unit_cost,
      prc_2: row.prc_2,
      prc_3: row.prc_3,
    }];
  }
  return cells.map((cell) => ({
    item_no: row.item_no,
    counterpoint_item_key: cell.counterpoint_item_key,
    sku: cell.sku,
    barcode: cell.barcode,
    retail_price: cell.retail_price ?? row.retail_price,
    unit_cost: cell.unit_cost ?? row.unit_cost,
    prc_2: cell.prc_2,
    prc_3: cell.prc_3,
  }));
}

function catalogCategoryVendorDiagnosticRow(row) {
  return {
    item_no: row.item_no,
    category: row.category,
    vendor_no: row.vendor_no,
  };
}

function catalogVariantLabelDiagnosticRows(row) {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  if (cells.length === 0) {
    return [{
      item_no: row.item_no,
      counterpoint_item_key: row.item_no,
      sku: row.item_no,
      barcode: row.barcode,
      variation_label: "",
    }];
  }
  return cells.map((cell) => ({
    item_no: row.item_no,
    counterpoint_item_key: cell.counterpoint_item_key,
    sku: cell.sku,
    barcode: cell.barcode,
    variation_label: cell.variation_label,
  }));
}

function inventoryQuantityCostDiagnosticRow(row) {
  return {
    counterpoint_item_key: row.counterpoint_item_key,
    sku: row.sku,
    stock_on_hand: row.stock_on_hand,
    unit_cost: row.unit_cost,
  };
}

async function postSnapshotReconciliation(snapshot, sourceCount, sourceSum, sourceChecksum) {
  const body = {
    snapshot,
    source_count: sourceCount,
  };
  if (sourceSum !== undefined && sourceSum !== null) {
    body.source_sum = sourceSum;
  }
  if (sourceChecksum !== undefined && sourceChecksum !== null) {
    body.source_checksum = sourceChecksum;
  }
  await rosFetch(
    "/api/sync/counterpoint/snapshot-reconciliation",
    body,
    "POST",
    bridgeIngestHeaders(),
  );
}

async function postFidelityDiagnostics(group, rows, limit = 50) {
  return await rosFetch(
    "/api/sync/counterpoint/fidelity-diagnostics",
    { group, rows, limit },
    "POST",
    bridgeIngestHeaders(),
  );
}

async function syncReceivingHistory(pool) {
  if (!String(effectiveSql.receiving_history ?? "").trim()) {
    throw new Error(
      "receiving_history runtime mapping unavailable. Run SQL smoke/auto-config against the Counterpoint DB, or set SYNC_RECEIVING_HISTORY=0 if receiving history is intentionally out of scope.",
    );
  }
  try {
    const result = await pool.request().query(effectiveSql.receiving_history);
    const rows = (result.recordset ?? []).map((r) => normalizeRowKeys(r));
    if (rows.length === 0) {
      console.info("[receiving_history] no rows");
      return;
    }

    const RECV_BATCH = 50;
    const CONCURRENCY = 2;
    const pendingRequests = [];
    const failures = [];
    let postedRows = 0;

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
          postedRows += chunk.length;
        })
        .catch((err) => {
          console.error("[receiving_history] batch failed:", err.message);
          failures.push(err);
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
    throwIfBatchFailures("receiving_history", failures, postedRows, rows.length);
    await postSnapshotReconciliation("receiving_history", rows.length);
    return postedRows;
  } catch (err) {
    console.error("[receiving_history] sync failed:", err?.message ?? err);
    throw err;
  }
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapCustomerRow(r) {
  return {
    cust_no: String(r.cust_no ?? r.customer_code ?? "").trim(),
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
  const itemNo = String(r.item_no ?? r.sku ?? "").trim();

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
    product_identity: itemNo,
    description:
      r.description ?? r.descr ?? r.name ?? r.nam ?? r.item_name ?? r.product_name ?? r.display_name ?? undefined,
    long_description: r.long_description ?? r.long_descr ?? undefined,
    brand: r.brand ?? undefined,
    category: r.category ?? r.categ_cod ?? r.category_name ?? undefined,
    vendor_no: r.vendor_no ?? r.vend_no ?? r.vendor_code ?? undefined,
    retail_price: r.retail_price != null ? String(r.retail_price) : (r.prc_1 != null ? String(r.prc_1) : undefined),
    prc_2: r.prc_2 != null ? String(r.prc_2) : undefined,
    prc_3: r.prc_3 != null ? String(r.prc_3) : undefined,
    unit_cost:
      r.unit_cost != null
        ? String(r.unit_cost)
        : r.cost_price != null
          ? String(r.cost_price)
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

function catalogVariantSourceCount(row) {
  return Array.isArray(row.cells) && row.cells.length > 0 ? row.cells.length : 1;
}

function catalogSkuSourceCount(row) {
  if (Array.isArray(row.cells) && row.cells.length > 0) {
    return row.cells.filter((cell) => String(cell.sku ?? "").trim() !== "").length;
  }
  return row.item_no ? 1 : 0;
}

function catalogBarcodeSourceCount(row) {
  if (Array.isArray(row.cells) && row.cells.length > 0) {
    return row.cells.filter((cell) => String(cell.barcode ?? "").trim() !== "").length;
  }
  return String(row.barcode ?? "").trim() !== "" ? 1 : 0;
}

function mapGiftCardRow(r, histRows) {
  const issueDat = r.issue_dat ?? r.issued_at;
  return {
    cert_no: String(r.cert_no ?? r.gft_cert_no ?? r.gift_cert_no ?? "").trim(),
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
    console.warn("[customers] runtime mapping unavailable; skip");
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
  logToDashboard(`[customers] SQL returned ${rows.length} customer(s)`);
  console.info("[customers] SQL returned", rows.length, "customer(s); sending with parallel-concurrency=2");

  const mapped = rows.map((row) => mapCustomerRow(normalizeRowKeys(row))).filter((r) => r.cust_no);
  const loyaltyPointSum = mapped.reduce((sum, row) => sum + intLikeToBigInt(row.loyalty_points), 0n);
  const pendingRequests = [];
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

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
        postedRows += chunk.length;
        if (last) lastSuccessfulCursor = last;
      })
      .catch((err) => {
        console.error("[customers] batch failed:", err.message);
        failures.push(err);
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
  throwIfBatchFailures("customers", failures, postedRows, mapped.length);
  if (lastSuccessfulCursor) {
    state.customers_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  await postSnapshotReconciliation("customers", mapped.length);
  await postSnapshotReconciliation(
    "loyalty_points",
    mapped.length,
    loyaltyPointSum.toString(),
  );
  return postedRows;
}

async function syncInventory(pool) {
  if (!String(effectiveSql.inventory ?? "").trim()) {
    console.warn("[inventory] runtime mapping unavailable; skip");
    return;
  }
  const state = readState();
  const result = await pool.request().query(effectiveSql.inventory);
  const rows = result.recordset ?? [];
  logToDashboard(`[inventory] SQL returned ${rows.length} item(s)`);
  const mapped = rows.map((row) => mapInventoryRow(normalizeRowKeys(row))).filter((r) => r.sku);
  const quantityCostChecksumRows = mapped.map(inventoryQuantityCostChecksumRow);
  const quantityCostDiagnosticRows = mapped.map(inventoryQuantityCostDiagnosticRow);

  const INV_BATCH = 400;
  const MAX_CONCURRENCY = 5;
  const pendingRequests = [];
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

  for (let i = 0; i < mapped.length; i += INV_BATCH) {
    const chunk = mapped.slice(i, i + INV_BATCH);
    const body = {
      rows: chunk,
      sync: { entity: "inventory", cursor: String(i + chunk.length) },
    };

    const promise = rosPost("inventory", body)
      .then((summary) => {
        console.info("[inventory] batch", summary);
        postedRows += chunk.length;
        lastSuccessfulCursor = String(i + chunk.length);
      })
      .catch((err) => {
        console.error("[inventory] batch failed:", err.message);
        failures.push(err);
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
  throwIfBatchFailures("inventory", failures, postedRows, mapped.length);
  if (lastSuccessfulCursor) {
    state.inventory_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  await postSnapshotReconciliation("inventory_quantity_rows", mapped.length);
  await postSnapshotReconciliation(
    "inventory_quantity_cost_fields",
    quantityCostChecksumRows.length,
    undefined,
    checksumRows(quantityCostChecksumRows),
  );
  await postFidelityDiagnostics("inventory_quantity_cost_fields", quantityCostDiagnosticRows);
  return postedRows;
}

function mapCategoryMasterRow(r) {
  return {
    cp_category: String(r.cp_category ?? "").trim(),
    display_name: r.display_name ?? r.descr ?? undefined,
  };
}

async function syncCategoryMasters(pool) {
  if (!String(effectiveSql.category_masters ?? "").trim()) {
    console.warn("[category_masters] runtime mapping unavailable; skip");
    return;
  }
  const result = await pool.request().query(effectiveSql.category_masters);
  const rows = (result.recordset ?? []).map((r) => mapCategoryMasterRow(normalizeRowKeys(r))).filter((x) => x.cp_category);
  if (rows.length === 0) {
    console.info("[category_masters] no rows");
    await postSnapshotReconciliation("counterpoint_categories", 0);
    return;
  }
  logToDashboard(`[category_masters] SQL returned ${rows.length} category(s)`);
  console.info("[category_masters] SQL returned", rows.length, "row(s); sending in batches of", BATCH);
  let postedRows = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.cp_category;
    const body = {
      rows: chunk,
      sync: { entity: "category_masters", cursor: last },
    };
    const summary = await rosPost("category_masters", body);
    console.info("[category_masters] batch", summary);
    postedRows += chunk.length;
  }
  await postSnapshotReconciliation("counterpoint_categories", rows.length);
  return postedRows;
}

async function syncCatalog(pool) {
  if (!String(effectiveSql.catalog ?? "").trim()) {
    console.warn("[catalog] runtime mapping unavailable; skip");
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

  const CATALOG_BATCH_SIZE = 400;
  const MAX_CONCURRENCY = 4;
  console.info(`[catalog] Starting ingest (batch=${CATALOG_BATCH_SIZE}, max_parallel=${MAX_CONCURRENCY})...`);

  const state = readState();
  const processedItemNos = new Set();
  let batchBuffer = [];
  let totalProcessed = 0;
  let totalRowsReceived = 0;
  let totalMappedRows = 0;
  let totalMappedVariants = 0;
  let totalMappedSkus = 0;
  let totalMappedBarcodes = 0;
  let totalMappedItemsWithVendor = 0;
  let totalMappedItemsWithCategory = 0;
  const catalogPriceCostChecksumParts = [];
  const catalogCategoryVendorChecksumParts = [];
  const catalogVariantLabelChecksumParts = [];
  const catalogPriceCostDiagnosticParts = [];
  const catalogCategoryVendorDiagnosticParts = [];
  const catalogVariantLabelDiagnosticParts = [];
  let skippedDuplicates = 0;
  let inFlight = 0;
  const pendingRequests = [];
  const failures = [];
  let lastSuccessfulCursor = null;

  return new Promise((resolve, reject) => {
    const request = pool.request();
    request.stream = true;
    request.timeout = SQL_REQUEST_TIMEOUT_MS;
    console.log(`[catalog] executing query...`);
    logToDashboard(
      `[catalog] SQL query started. Waiting for rows (stall timeout ${Math.round(CATALOG_SQL_STALL_TIMEOUT_MS / 1000)}s).`,
    );
    let settled = false;
    let lastActivityAt = Date.now();
    let lastLoggedRowsReceived = 0;
    const markCatalogActivity = () => {
      lastActivityAt = Date.now();
    };
    const cleanupCatalogWatchdog = () => {
      clearInterval(catalogWatchdog);
    };
    const failCatalog = (err) => {
      if (settled) return;
      settled = true;
      cleanupCatalogWatchdog();
      try {
        request.cancel();
      } catch {
        // Best-effort cancellation. The SQL driver may already be closing the stream.
      }
      reject(err);
    };
    const catalogWatchdog = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs >= CATALOG_SQL_STALL_TIMEOUT_MS) {
        const err = new Error(
          `Catalog SQL made no progress for ${Math.round(idleMs / 1000)}s. Run Auto Config or raise CATALOG_SQL_STALL_TIMEOUT_MS.`,
        );
        console.error(`[catalog] ${err.message}`);
        logToDashboard(`[catalog] failed: ${err.message}`);
        failCatalog(err);
        return;
      }
      if (totalRowsReceived === 0) {
        logToDashboard(
          `[catalog] still waiting for first SQL row (${Math.round(idleMs / 1000)}s idle).`,
        );
      } else if (totalRowsReceived !== lastLoggedRowsReceived) {
        lastLoggedRowsReceived = totalRowsReceived;
        logToDashboard(
          `[catalog] streaming: ${totalRowsReceived} SQL rows read, ${totalProcessed} items sent.`,
        );
      }
    }, SQL_PROGRESS_LOG_MS);
    request.on("row", (row) => {
      if (settled) return;
      markCatalogActivity();
      totalRowsReceived++;
      const normalized = normalizeRowKeys(row);
      const itemNo = String(normalized.item_no ?? normalized.sku ?? "").trim();

      if (!itemNo || processedItemNos.has(itemNo)) {
        if (itemNo && processedItemNos.has(itemNo)) skippedDuplicates++;
        return;
      }
      processedItemNos.add(itemNo);

      const mapped = mapCatalogRow(normalized, cellLookup[itemNo] ?? []);

      if (mapped.item_no) {
        totalMappedRows++;
        totalMappedVariants += catalogVariantSourceCount(mapped);
        totalMappedSkus += catalogSkuSourceCount(mapped);
        totalMappedBarcodes += catalogBarcodeSourceCount(mapped);
        if (String(mapped.vendor_no ?? "").trim()) totalMappedItemsWithVendor++;
        if (String(mapped.category ?? "").trim()) totalMappedItemsWithCategory++;
        catalogPriceCostChecksumParts.push(...catalogPriceCostChecksumRows(mapped));
        catalogCategoryVendorChecksumParts.push(catalogCategoryVendorChecksumRow(mapped));
        catalogVariantLabelChecksumParts.push(...catalogVariantLabelChecksumRows(mapped));
        catalogPriceCostDiagnosticParts.push(...catalogPriceCostDiagnosticRows(mapped));
        catalogCategoryVendorDiagnosticParts.push(catalogCategoryVendorDiagnosticRow(mapped));
        catalogVariantLabelDiagnosticParts.push(...catalogVariantLabelDiagnosticRows(mapped));
        batchBuffer.push(mapped);
        if (batchBuffer.length >= CATALOG_BATCH_SIZE) {
          const chunk = [...batchBuffer];
          batchBuffer = [];

          const last = chunk[chunk.length - 1].item_no;
          inFlight++;
          if (inFlight >= MAX_CONCURRENCY) request.pause();

          const promise = rosPost("catalog", { rows: chunk, sync: { entity: "catalog", cursor: last } })
            .then((summary) => {
              markCatalogActivity();
              totalProcessed += chunk.length;
              if (totalProcessed % 500 === 0) {
                logToDashboard(`[catalog] ingest: ${totalProcessed} items processed...`);
                console.info(`[catalog] progress: ${totalProcessed} items (skipped ${skippedDuplicates} duplicates)...`);
              }
              if (last) lastSuccessfulCursor = last;
              inFlight--;
              if (inFlight < MAX_CONCURRENCY) request.resume();
            })
            .catch((err) => {
              markCatalogActivity();
              console.error("[catalog] batch failed:", err.message);
              failures.push(err);
              inFlight--;
              if (inFlight < MAX_CONCURRENCY) request.resume();
            });
          pendingRequests.push(promise);
        }
      }
    });

    request.on("error", (err) => {
      if (settled) return;
      console.error("[catalog] stream error:", err.message);
      failCatalog(err);
    });

    request.on("done", async () => {
      if (settled) return;
      markCatalogActivity();
      try {
        if (batchBuffer.length > 0) {
          const chunk = [...batchBuffer];
          const last = chunk[chunk.length - 1].item_no;
          pendingRequests.push(
            rosPost("catalog", { rows: chunk, sync: { entity: "catalog", cursor: last } })
              .then((summary) => {
                console.info("[catalog] batch", summary);
                markCatalogActivity();
                totalProcessed += chunk.length;
                if (last) lastSuccessfulCursor = last;
              })
              .catch((err) => {
                markCatalogActivity();
                console.error("[catalog] batch failed:", err.message);
                failures.push(err);
              }),
          );
        }
        await Promise.all(pendingRequests);
        throwIfBatchFailures("catalog", failures, totalProcessed, totalMappedRows);
        if (lastSuccessfulCursor) {
          state.catalog_cursor = lastSuccessfulCursor;
          writeState(state);
        }
        await postSnapshotReconciliation("catalog_products", totalMappedRows);
        await postSnapshotReconciliation("catalog_variants", totalMappedVariants);
        await postSnapshotReconciliation("catalog_variant_skus", totalMappedSkus);
        await postSnapshotReconciliation("catalog_variant_barcodes", totalMappedBarcodes);
        await postSnapshotReconciliation("catalog_items_with_vendor", totalMappedItemsWithVendor);
        await postSnapshotReconciliation("catalog_items_with_category", totalMappedItemsWithCategory);
        await postSnapshotReconciliation(
          "catalog_price_cost_fields",
          catalogPriceCostChecksumParts.length,
          undefined,
          checksumRows(catalogPriceCostChecksumParts),
        );
        await postSnapshotReconciliation(
          "catalog_category_vendor_fields",
          catalogCategoryVendorChecksumParts.length,
          undefined,
          checksumRows(catalogCategoryVendorChecksumParts),
        );
        await postSnapshotReconciliation(
          "catalog_variant_label_fields",
          catalogVariantLabelChecksumParts.length,
          undefined,
          checksumRows(catalogVariantLabelChecksumParts),
        );
        await postFidelityDiagnostics("catalog_price_cost_fields", catalogPriceCostDiagnosticParts);
        await postFidelityDiagnostics("catalog_category_vendor_fields", catalogCategoryVendorDiagnosticParts);
        await postFidelityDiagnostics("catalog_variant_label_fields", catalogVariantLabelDiagnosticParts);
        logToDashboard(`[catalog] finished. ${totalProcessed} items synced (SQL gave ${totalRowsReceived} rows, skipped ${skippedDuplicates} duplicates).`);
        console.info(`[catalog] finished. ${totalProcessed} total items synced.`);
        settled = true;
        cleanupCatalogWatchdog();
        resolve(totalProcessed);
      } catch (e) {
        failCatalog(e);
      }
    });

    request.query(effectiveSql.catalog).catch((err) => {
      if (settled) return;
      console.error("[catalog] query failed:", err.message);
      failCatalog(err);
    });
  });
}

async function syncGiftCards(pool) {
  if (!String(effectiveSql.gift_cards ?? "").trim()) {
    console.warn("[gift_cards] runtime mapping unavailable; skip");
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
      const certNo = String(r.cert_no ?? r.gft_cert_no ?? r.gift_cert_no ?? "").trim();
      return mapGiftCardRow(r, histLookup[certNo] ?? []);
    })
    .filter((r) => r.cert_no);
  const giftBalanceSum = mapped.reduce(
    (sum, row) => sum + decimalToScaledInt(row.balance, 2),
    0n,
  );

  logToDashboard(`[gift_cards] SQL returned ${mapped.length} card(s)`);
  const CONCURRENCY = 2;
  const pendingRequests = [];
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;
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
        postedRows += chunk.length;
        if (last) lastSuccessfulCursor = last;
      })
      .catch((err) => {
        console.error("[gift_cards] batch failed:", err.message);
        failures.push(err);
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
  throwIfBatchFailures("gift_cards", failures, postedRows, mapped.length);
  if (lastSuccessfulCursor) {
    state.gift_cards_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  await postSnapshotReconciliation(
    "gift_cards",
    mapped.length,
    scaledIntToDecimalString(giftBalanceSum, 2),
  );
  return postedRows;
}

async function syncTickets(pool) {
  if (!String(effectiveSql.tickets ?? "").trim()) {
    console.warn("[tickets] runtime mapping unavailable; skip");
    return;
  }

  console.info(`[tickets] Executing SQL: ${effectiveSql.tickets}`);
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
      console.warn("[tickets] Run DISCOVER_SCHEMA.cmd or Auto Config to inspect actual PS_TKT_HIST_LIN columns.");
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
      if (!giftLookup[ref]) giftLookup[ref] = [];
      giftLookup[ref].push(nr);
    }
  }

  let noteLookup = {};
  if (SYNC_TICKET_NOTES && String(effectiveSql.ticket_notes ?? "").trim()) {
    try {
      const noteResult = await pool.request().query(effectiveSql.ticket_notes);
      for (const row of noteResult.recordset ?? []) {
        const nr = normalizeRowKeys(row);
        // Robust fallback: Counterpoint schemas may use DOC_ID, TKT_NO, or TKT_REF.
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

  logToDashboard(`[tickets] SQL returned ${mapped.length} ticket(s)`);
  const recordCount = mapped.length;
  const sourceLineCount = mapped.reduce((sum, ticket) => sum + (ticket.lines?.length ?? 0), 0);
  const sourcePaymentCount = mapped.reduce((sum, ticket) => sum + (ticket.payments?.length ?? 0), 0);
  const sourcePaymentSum = mapped.reduce(
    (sum, ticket) =>
      sum + (ticket.payments ?? []).reduce((inner, payment) => inner + decimalToScaledInt(payment.amount, 2), 0n),
    0n,
  );
  const TICKET_BATCH = Math.max(1, Number.parseInt(process.env.TICKET_BATCH_SIZE ?? "200", 10));
  const TICKET_CONCURRENCY = Math.max(1, Number.parseInt(process.env.TICKET_CONCURRENCY ?? "4", 10));

  console.info(`[tickets] Processing mapped headers (batch=${TICKET_BATCH}, concurrency=${TICKET_CONCURRENCY})...`);
  const state = readState();
  const pendingRequests = [];
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

  for (let i = 0; i < mapped.length; i += TICKET_BATCH) {
    const chunk = mapped.slice(i, i + TICKET_BATCH);
    const last = chunk[chunk.length - 1]?.ticket_ref;
    const body = {
      rows: chunk,
      sync: { entity: "tickets", cursor: last },
    };

    const promise = rosPost("tickets", body)
      .then((summary) => {
        console.info("[tickets] batch", summary);
        postedRows += chunk.length;
        if (last) lastSuccessfulCursor = last;
      })
      .catch((err) => {
        console.error("[tickets] batch failed:", err.message);
        failures.push(err);
      })
      .finally(() => {
        pendingRequests.splice(pendingRequests.indexOf(promise), 1);
      });

    pendingRequests.push(promise);
    if (pendingRequests.length >= TICKET_CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
  throwIfBatchFailures("tickets", failures, postedRows, recordCount);
  if (lastSuccessfulCursor) {
    state.tickets_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  await postSnapshotReconciliation("tickets", recordCount);
  await postSnapshotReconciliation("ticket_lines", sourceLineCount);
  await postSnapshotReconciliation(
    "ticket_payments",
    sourcePaymentCount,
    scaledIntToDecimalString(sourcePaymentSum, 2),
  );
  return postedRows;
}

async function syncStoreCreditOpening(pool) {
  if (!String(effectiveSql.store_credit ?? "").trim()) {
    console.warn("[store_credit_opening] runtime mapping unavailable; skip");
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

  logToDashboard(`[store_credit_opening] SQL returned ${mapped.length} record(s)`);
  console.info("[store_credit_opening] Sending opening balances (parallel-concurrency=5)...");
  const state = readState();
  const CONCURRENCY = 2;
  const pendingRequests = [];
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

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
        postedRows += chunk.length;
        if (last) lastSuccessfulCursor = last;
      })
      .catch((err) => {
        console.error("[store_credit_opening] batch failed:", err.message);
        failures.push(err);
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
  throwIfBatchFailures("store_credit_opening", failures, postedRows, mapped.length);
  if (lastSuccessfulCursor) {
    state.store_credit_opening_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  const storeCreditSum = mapped.reduce((sum, row) => sum + decimalToScaledInt(row.balance, 2), 0n);
  await postSnapshotReconciliation(
    "store_credit_opening",
    mapped.length,
    scaledIntToDecimalString(storeCreditSum, 2),
  );
  return postedRows;
}

async function syncOpenDocs(pool) {
  if (!String(effectiveSql.open_docs ?? "").trim()) {
    console.warn("[open_docs] runtime mapping unavailable; skip");
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

  const recordCount = mapped.length;
  const sourceLineCount = mapped.reduce((sum, doc) => sum + (doc.lines?.length ?? 0), 0);
  const sourcePaymentCount = mapped.reduce((sum, doc) => sum + (doc.payments?.length ?? 0), 0);
  const sourcePaymentSum = mapped.reduce(
    (sum, doc) =>
      sum + (doc.payments ?? []).reduce((inner, payment) => inner + decimalToScaledInt(payment.amount, 2), 0n),
    0n,
  );
  logToDashboard(`[open_docs] SQL returned ${recordCount} doc(s)`);
  console.info("[open_docs] Sending items (parallel-concurrency=5)...");
  const state = readState();
  const CONCURRENCY = 2;
  const pendingRequests = [];
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

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
        postedRows += chunk.length;
        if (last) lastSuccessfulCursor = last;
      })
      .catch((err) => {
        console.error("[open_docs] batch failed:", err.message);
        failures.push(err);
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
  throwIfBatchFailures("open_docs", failures, postedRows, recordCount);
  if (lastSuccessfulCursor) {
    state.open_docs_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  await postSnapshotReconciliation("open_docs", recordCount);
  await postSnapshotReconciliation("open_doc_lines", sourceLineCount);
  await postSnapshotReconciliation(
    "open_doc_payments",
    sourcePaymentCount,
    scaledIntToDecimalString(sourcePaymentSum, 2),
  );
  return postedRows;
}

async function syncLoyaltyHist(pool) {
  if (!String(effectiveSql.loyalty ?? "").trim()) {
    console.warn("[loyalty_hist] runtime mapping unavailable; skip");
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

  const recordCount = mapped.length;
  logToDashboard(`[loyalty_hist] SQL returned ${recordCount} record(s)`);
  console.info("[loyalty_hist] SQL returned", recordCount, "row(s); sending with parallel-concurrency=5");

  const CONCURRENCY = 2;
  const pendingRequests = [];
  const failures = [];
  let postedRows = 0;

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const body = {
      rows: chunk,
      sync: { entity: "loyalty_hist", cursor: String(i + chunk.length) },
    };

    const promise = rosPost("loyalty_hist", body)
      .then((summary) => {
        console.info("[loyalty_hist] batch", summary);
        postedRows += chunk.length;
      })
      .catch((err) => {
        console.error("[loyalty_hist] batch failed:", err.message);
        failures.push(err);
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
  throwIfBatchFailures("loyalty_hist", failures, postedRows, recordCount);
  return postedRows;
}

async function syncVendorItems(pool) {
  if (!String(effectiveSql.vend_item ?? "").trim()) {
    console.warn("[vendor_items] runtime mapping unavailable; skip");
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

  logToDashboard(`[vendor_items] SQL returned ${mapped.length} record(s)`);
  console.info("[vendor_items] SQL returned", mapped.length, "row(s); sending with parallel-concurrency=5");

  const CONCURRENCY = 2;
  const pendingRequests = [];
  const state = readState();
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const cursor = String(i + chunk.length);
    const body = { rows: chunk, sync: { entity: "vendor_items", cursor } };

    const promise = rosPost("vendor_items", body).then(summary => {
      console.info("[vendor_items] batch", summary);
      postedRows += chunk.length;
      lastSuccessfulCursor = cursor;
    }).catch(err => {
      console.error("[vendor_items] batch failed:", err.message);
      failures.push(err);
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
  throwIfBatchFailures("vendor_items", failures, postedRows, mapped.length);
  if (lastSuccessfulCursor) {
    state.vendor_items_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  return postedRows;
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
    await postSnapshotReconciliation("counterpoint_vendors", 0);
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

  const recordCount = mapped.length;
  logToDashboard(`[vendors] SQL returned ${recordCount} record(s)`);
  console.info("[vendors] SQL returned", recordCount, "row(s); sending with parallel-concurrency=2");

  const CONCURRENCY = 2;
  const pendingRequests = [];
  const state = readState();
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const last = chunk[chunk.length - 1]?.vend_no;
    const body = { rows: chunk, sync: { entity: "vendors", cursor: last } };

    const promise = rosPost("vendors", body).then(summary => {
      console.info("[vendors] batch", summary);
      postedRows += chunk.length;
      if (last) lastSuccessfulCursor = last;
    }).catch(err => {
      console.error("[vendors] batch failed:", err.message);
      failures.push(err);
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
  throwIfBatchFailures("vendors", failures, postedRows, recordCount);
  if (lastSuccessfulCursor) {
    state.vendors_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  await postSnapshotReconciliation("counterpoint_vendors", recordCount);
  return postedRows;
}

async function syncCustomerNotes(pool) {
  if (!String(effectiveSql.customer_notes ?? "").trim()) {
    console.warn("[customer_notes] runtime mapping unavailable; skip");
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

  const CONCURRENCY = 2;
  const pendingRequests = [];
  const state = readState();
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const cursor = String(i + chunk.length);
    const body = { rows: chunk, sync: { entity: "customer_notes", cursor } };

    const promise = rosPost("customer_notes", body).then(summary => {
      console.info("[customer_notes] batch", summary);
      postedRows += chunk.length;
      lastSuccessfulCursor = cursor;
    }).catch(err => {
      console.error("[customer_notes] batch failed:", err.message);
      failures.push(err);
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
  throwIfBatchFailures("customer_notes", failures, postedRows, mapped.length);
  if (lastSuccessfulCursor) {
    state.customer_notes_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  return postedRows;
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

  const CONCURRENCY = 2;
  const pendingRequests = [];
  const state = readState();
  const failures = [];
  let postedRows = 0;
  let lastSuccessfulCursor = null;

  for (let i = 0; i < allRows.length; i += BATCH) {
    const chunk = allRows.slice(i, i + BATCH);
    const cursor = String(i + chunk.length);
    const body = { rows: chunk, sync: { entity: "staff", cursor } };

    const promise = rosPost("staff", body).then(summary => {
      console.info("[staff] batch", summary);
      postedRows += chunk.length;
      lastSuccessfulCursor = cursor;
    }).catch(err => {
      console.error("[staff] batch failed:", err.message);
      failures.push(err);
    }).finally(() => {
      pendingRequests.splice(pendingRequests.indexOf(promise), 1);
    });

    pendingRequests.push(promise);
    if (pendingRequests.length >= CONCURRENCY) {
      await Promise.race(pendingRequests);
    }
  }
  await Promise.all(pendingRequests);
  throwIfBatchFailures("staff", failures, postedRows, allRows.length);
  if (lastSuccessfulCursor) {
    state.staff_cursor = lastSuccessfulCursor;
    writeState(state);
  }
  return postedRows;
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
  return codes.length;
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
      note("No LST_COST / AVG_COST / LAST_COST — runtime mappings will omit cost until a supported cost column is available.");
    } else {
      const primary = found[0];
      const tpl = "LST_COST";
      dline("IM_INV cost column", primary === tpl);
      if (primary === tpl) {
        note(`Template already uses ${primary} — no change needed for inventory/catalog cost.`);
      } else {
        note(`Your DB uses ${primary}. Runtime mappings will use that column automatically.`);
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
      note(`Runtime mappings will use ${vcol} as the IM_ITEM vendor column.`);
    } else {
      dline("IM_ITEM vendor column", false);
      if (vendLike.length > 1) {
        note(
          `Several columns match *VND*/*VEND*: ${vendLike.join(", ")} — set CP_IM_ITEM_VENDOR_COLUMN to the primary vendor code, or CP_IM_ITEM_VENDOR_SOURCE=po_vend_item.`,
        );
      } else {
        note(
          "No vendor column on IM_ITEM — runtime mappings will use PO_VEND_ITEM links when available.",
        );
      }
    }
    if (imItem.has("SUBCATEG_COD")) {
      dline("IM_ITEM SUBCATEG_COD", true);
      note("Optional subcategory data is visible; runtime mappings currently use CATEG_COD as the category key.");
    } else {
      dline("IM_ITEM SUBCATEG_COD", false);
      note("Absent — defaults use CATEG_COD only.");
    }
  }

  const poVend = columnSet(entries, "PO_VEND");
  if (poVend) {
    dline("PO_VEND VEND_NO", poVend.has("VEND_NO"));
    if (!poVend.has("VEND_NO")) {
      note("No VEND_NO on PO_VEND — vendor sync will skip unless an expert SQL override maps the vendor code.");
    }
    const nameCol = poVend.has("NAM")
      ? "NAM"
      : ["NAME", "VEND_NAM", "DESCR"].find((c) => poVend.has(c));
    dline("PO_VEND name column (NAM)", !!nameCol);
    if (!nameCol) {
      note("No NAM/NAME-style column on PO_VEND — vendor names will be unavailable unless an expert SQL override maps the name.");
    } else if (nameCol !== "NAM") {
      note(`Runtime mappings will use ${nameCol} as the vendor name column.`);
    }
    dline("PO_VEND TERMS_COD", poVend.has("TERMS_COD"));
    if (!poVend.has("TERMS_COD")) {
      note(
        "TERMS_COD absent — runtime mappings will send NULL payment_terms.",
      );
    }
  }

  const ar = columnSet(entries, "AR_CUST");
  if (ar) {
    const pts = ["PTS_BAL", "LOY_PTS", "LOY_PTS_BAL"].find((c) => ar.has(c));
    if (pts) {
      dline("AR_CUST points column", true);
      note(`Found ${pts} — runtime mappings will use it as pts_bal.`);
    } else {
      dline("AR_CUST points column", false);
      note("No PTS_BAL / LOY_PTS / LOY_PTS_BAL — runtime mappings will send NULL points.");
    }
  }

  const usr = columnSet(entries, "SY_USR");
  if (usr) {
    if (usr.has("USR_GRP_ID")) {
      dline("SY_USR USR_GRP_ID", true);
      note("Runtime mappings will use USR_GRP_ID for staff group when visible.");
    } else {
      dline("SY_USR USR_GRP_ID", false);
      note("Column absent — template NULL usr_grp_id is correct.");
    }
    if (!usr.has("EMAIL_ADRS")) {
      dline("SY_USR EMAIL_ADRS", false);
      note("No email column detected; runtime mappings will send NULL email_adrs.");
    }
  }

  const rep = columnSet(entries, "PS_SLS_REP");
  if (rep?.has("COMMIS_METH")) {
    dline("PS_SLS_REP COMMIS_METH", true);
    note("Optional COMMIS_METH is visible; runtime mappings currently use commission percent only.");
  }

  const tkt = columnSet(entries, "PS_TKT_HIST");
  if (tkt) {
    if (tkt.has("TOT_AMT_DUE") && tkt.has("TOT_EXTD_PRC")) {
      dline("PS_TKT_HIST amount paid", true);
      note("Runtime mappings will calculate amount_paid from total minus amount due.");
    } else if (!tkt.has("TOT_AMT_DUE")) {
      dline("PS_TKT_HIST TOT_AMT_DUE", false);
      note("Absent — keep TOT_EXTD_PRC AS amount_paid (fully-paid assumption for closed tickets).");
    }
    if (!tkt.has("TOT_EXTD_PRC") && tkt.has("TOT")) {
      dline("PS_TKT_HIST totals", false);
      note("TOT_EXTD_PRC missing — runtime mappings will use TOT when visible.");
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
      note(`Runtime mappings will use ${v} as vendor cost.`);
    } else {
      dline("PO_VEND_ITEM vendor cost", false);
      note("No common cost column name — leave NULL or pick a column in SSMS.");
    }
  }

  const hasGfc = pickTableEntry(entries, "SY_GFC");
  const giftTemplateOk = !!hasGfc;
  dline("Gift cards (SY_GFC template)", giftTemplateOk);
  if (giftTemplateOk) {
    note("Set SYNC_GIFT_CARDS=1 in .env to import.");
  } else {
    note("No SY_GFC — keep SYNC_GIFT_CARDS=0.");
  }

  dline("Loyalty balance snapshot (AR_CUST pts_bal)", true);
  note("Historical loyalty remains disabled for cutover. Runtime customer mappings import current balances as pts_bal.");

  if (ticketCellOk) {
    dline("Ticket matrix cells (PS_TKT_HIST_*CELL)", true);
    if (visible.has("PS_TKT_HIST_LIN_CELL") && !visible.has("PS_TKT_HIST_CELL")) {
      note("PS_TKT_HIST_LIN_CELL is available for ticket matrix detail.");
    } else if (visible.has("PS_TKT_HIST_CELL")) {
      note("PS_TKT_HIST_CELL is available for ticket matrix detail.");
    }
  } else {
    dline("Ticket matrix cells (PS_TKT_HIST_*CELL)", false);
    note("Leave CP_TICKET_CELLS_QUERY empty; ticket lines use parent ITEM_NO for variant key.");
  }

  emit("");
  emit("  Review the runtime mapping notes above, then run START_BRIDGE.cmd");
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

function updateEnvKey(content, key, value) {
  const regex = new RegExp(`^\\s*#?\\s*${key}\\s*=.*$`, "m");
  const newLine = `${key}=${value}`;
  if (regex.test(content)) {
    return content.replace(regex, newLine);
  } else {
    return content + `\n${newLine}`;
  }
}

async function runAutoConfig(pool) {
  console.info("Probing Counterpoint SQL Server database schemas...");
  await rebuildEffectiveSql(pool);
  const changes = lastAutoConfigChanges;
  console.info("\n══════════════════════════════════════════════════════════════════════");
  console.info("  Auto-config generated runtime SQL mappings from the live schema.");
  if (changes.length > 0) {
    console.info("  Runtime mappings:");
    for (const change of changes) {
      console.info(`    - ${change}`);
    }
  } else {
    console.info("  No supported Counterpoint tables were visible to this SQL login.");
  }
  console.info("══════════════════════════════════════════════════════════════════════\n");
  return changes;
}

async function runSqlSmoke(pool) {
  console.info("Probing Counterpoint SQL Server runtime SQL mappings...");
  await rebuildEffectiveSql(pool);
  validateCounterpointSyncDependencyPlan();

  const checks = [
    ["staff.users", "users"],
    ["staff.sales_reps", "sales_reps"],
    ["staff.buyers", "buyers"],
    ["vendors", SYNC_VENDORS_FILTERED ? "vendors_filtered" : "vendors_fast_simple"],
    ["customers", "customers"],
    ["store_credit_opening", "store_credit"],
    ["customer_notes", "customer_notes"],
    ["category_masters", "category_masters"],
    ["catalog", "catalog"],
    ["catalog_cells", "catalog_cells"],
    ["inventory", "inventory"],
    ["vendor_items", "vend_item"],
    ["gift_cards", "gift_cards"],
    ["tickets", "tickets"],
    ["ticket_lines", "ticket_lines"],
    ["ticket_payments", "ticket_payments"],
    ["ticket_notes", "ticket_notes"],
    ["open_docs", "open_docs"],
    ["open_doc_lines", "open_doc_lines"],
    ["open_doc_payments", "open_doc_pmt"],
    ["receiving_history", "receiving_history"],
  ];

  const failures = [];
  for (const [label, key] of checks) {
    const q = String(effectiveSql[key] ?? "").trim();
    if (!q) {
      const message = `${label}: runtime mapping unavailable`;
      if (label === "receiving_history" && SYNC_RECEIVING_HISTORY) {
        failures.push({ label, message });
        console.error(`[sql-smoke] ${message}`);
      } else {
        console.info(`[sql-smoke] ${label}: skipped (runtime mapping unavailable)`);
      }
      continue;
    }
    try {
      const result = await pool.request().query(`SET ROWCOUNT 1;\n${q};\nSET ROWCOUNT 0;`);
      const rowCount = result.recordset?.length ?? 0;
      const columns = result.recordset?.columns ? Object.keys(result.recordset.columns).length : 0;
      console.info(
        `[sql-smoke] ${label}: ok (${rowCount > 0 ? "row visible" : "empty"}, ${columns} column${columns === 1 ? "" : "s"})`,
      );
    } catch (e) {
      try {
        await pool.request().query("SET ROWCOUNT 0;");
      } catch {
        // Keep the original SQL error as the actionable failure.
      }
      failures.push({ label, message: e?.message ?? String(e) });
      console.error(`[sql-smoke] ${label}: failed - ${e?.message ?? e}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} runtime SQL mapping(s) failed smoke validation.`);
  }
  console.info("[sql-smoke] all available runtime SQL mappings compiled successfully.");
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/** Isolate entity failures so one bad SQL query does not hide which entity failed. */
async function runSyncEntity(entityLabel, fn) {
  const t0 = Date.now();
  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat("syncing", entityLabel);
  }, 30_000);
  try {
    await signalRunStart(entityLabel, null);
    const result = await fn();
    const count = typeof result === 'number' ? result : (BRIDGE_STATE.entityStats[entityLabel]?.recordCount ?? 0);
    const dur = Date.now() - t0;

    const state = readState();
    // Only advance the anchor date if we pulled something, OR if it's already set.
    // This prevents a failed/empty initial run from locking us to "today".
    if (count > 0 || state[`${entityLabel}_last_date`]) {
      const dt = new Date(Date.now() - (86400000 * 2));
      const dtStr = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, '0') + "-" + String(dt.getDate()).padStart(2, '0');
      state[`${entityLabel}_last_date`] = dtStr;
      state.global_last_date = dtStr;
      writeState(state);
    }

    BRIDGE_STATE.entityStats[entityLabel] = {
      ...BRIDGE_STATE.entityStats[entityLabel],
      lastSync: new Date().toISOString(),
      durationMs: dur,
      recordCount: count,
      error: null,
    };
    BRIDGE_STATE.totalRecordsLastRun += count;
    pushEvent('complete', entityLabel, `Synced successfully`, { durationMs: dur, recordCount: count });
  } catch (e) {
    const msg = e?.message ?? String(e);
    const dur = Date.now() - t0;

    BRIDGE_STATE.entityStats[entityLabel] = {
      ...BRIDGE_STATE.entityStats[entityLabel],
      lastSync: new Date().toISOString(),
      error: msg,
      durationMs: dur,
    };
    pushEvent('error', entityLabel, msg, { durationMs: dur });
    throw e;
  } finally {
    clearInterval(heartbeatTimer);
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
    {
      on: SYNC_CATEGORY_MASTERS,
      label: "category_masters",
      hb: "category_masters",
      run: () => syncCategoryMasters(pool),
    },
    { on: SYNC_VENDORS, label: "vendors", hb: "vendors", run: () => syncVendors(pool) },
    { on: SYNC_CATALOG, label: "catalog", hb: "catalog", run: () => syncCatalog(pool) },
    { on: SYNC_VENDOR_ITEMS, label: "vendor_items", hb: "vendor_items", run: () => syncVendorItems(pool) },
    { on: SYNC_INVENTORY, label: "inventory", hb: "inventory", run: () => syncInventory(pool) },
    { on: SYNC_CUSTOMERS, label: "customers", hb: "customers", run: () => syncCustomers(pool) },
    { on: SYNC_CUSTOMER_NOTES, label: "customer_notes", hb: "customer_notes", run: () => syncCustomerNotes(pool) },
    { on: SYNC_TICKETS, label: "tickets", hb: "tickets", run: () => syncTickets(pool) },
    { on: SYNC_RECEIVING_HISTORY, label: "receiving_history", hb: "receiving_history", run: () => syncReceivingHistory(pool) },
    { on: SYNC_OPEN_DOCS, label: "open_docs", hb: "open_docs", run: () => syncOpenDocs(pool) },
    {
      on: SYNC_STORE_CREDIT_OPENING,
      label: "store_credit_opening",
      hb: "store_credit_opening",
      run: () => syncStoreCreditOpening(pool),
    },
    { on: SYNC_LOYALTY_HIST, label: "loyalty_hist", hb: "loyalty_hist", run: () => syncLoyaltyHist(pool) },
    { on: SYNC_GIFT_CARDS, label: "gift_cards", hb: "gift_cards", run: () => syncGiftCards(pool) },
  ];
}

async function main() {
  if (PREFLIGHT_MODE) {
    await runPreflightCommand();
    process.exit(0);
  }
  if (ALIASES_MODE) {
    await runAliasesCommand();
    process.exit(0);
  }
  if (NORMALIZATION_MODE) {
    await runNormalizationCommand();
    process.exit(0);
  }
  if (LIGHTSPEED_REFERENCE_MODE) {
    await runLightspeedReferenceCommand();
    process.exit(0);
  }

  if (SQL_SMOKE_MODE) {
    if (!CONN.trim()) {
      console.error("Set SQL_CONNECTION_STRING in .env");
      process.exit(1);
    }
    const pool = createSqlPool();
    pool.on("error", (err) => console.error("SQL pool error", err));
    try {
      await pool.connect();
      await runSqlSmoke(pool);
    } catch (e) {
      console.error("[sql-smoke] failed:", e?.message ?? e);
      process.exit(1);
    } finally {
      await pool.close();
    }
    process.exit(0);
  }

  if (AUTOCONFIG_MODE) {
    if (!CONN.trim()) {
      console.error("Set SQL_CONNECTION_STRING in .env");
      process.exit(1);
    }
    const pool = createSqlPool();
    pool.on("error", (err) => console.error("SQL pool error", err));
    try {
      await pool.connect();
      await runAutoConfig(pool);
    } catch (e) {
      console.error("[auto-config] failed:", e?.message ?? e);
      process.exit(1);
    } finally {
      await pool.close();
    }
    process.exit(0);
  }

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
  requireImportFirstIngestMode();
  bridgeHostnameCached = os.hostname();

  // Start the Bridge Command Dashboard (Port 3002)
  startLocalServer();

  if (DRY_RUN_MODE) {
    console.info("⚡ DRY-RUN ACTIVE: Bridge will fetch data from Counterpoint but will NOT post updates to Riverside OS.");
    try {
      await refreshRosStagingFromHealth();
    } catch (e) {
      console.warn(`[dry-run] ROS health check failed (${e?.message ?? e}). Proceeding in dry-run mode without live connection.`);
      rosStagingEnabled = false;
    }
  } else {
    await refreshRosStagingFromHealth();
  }
  console.info(
    "ROS sync health OK",
    rosStagingEnabled ? "(counterpoint staging ingest)" : "(direct entity ingest)",
  );

  logCanonicalSyncOrder();

  const pool = createSqlPool();
  ACTIVE_POOL = pool;
  pool.on("error", (err) => console.error("SQL pool error", err));

  let connected = false;
  let attempts = 0;
  const MAX_ATTEMPTS = 20;
  const RETRY_DELAY_MS = 5000;

  while (attempts < MAX_ATTEMPTS && !connected) {
    try {
      attempts++;
      if (attempts > 1) console.info(`Retrying SQL connection (attempt ${attempts}/${MAX_ATTEMPTS})...`);
      await pool.connect();
      connected = true;
    } catch (err) {
      console.error(`SQL connection failed (attempt ${attempts}): ${err.message}`);
      if (err.message.includes("ETIMEOUT") || err.message.includes("Connection lost")) {
          console.warn("Hint: Ensure you are connected to the Tailscale tunnel or the shop's LAN.");
      }
      if (attempts < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error("Critical: Maximum SQL connection attempts reached. The bridge will continue running the local dashboard, but sync will be disabled.");
      }
    }
  }

  if (connected) {
    console.info(
      `SQL Server connected. SQL requestTimeout=${SQL_REQUEST_TIMEOUT_MS}ms, ROS fetch timeout=${ROS_FETCH_TIMEOUT_MS}ms.`,
    );
  }

  await rebuildEffectiveSql(pool);
  validateCounterpointSyncDependencyPlan();
  await runImportFirstSourcePreflight(pool);

  console.info(
    `[ingest] Mode: ${
      rosStagingEnabled
        ? "support queue — batches queue in ROS until staff apply them from diagnostics"
        : "import-first direct — each supported batch lands in ROS with proof and exception tracking"
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

  let isTickRunning = false;
  const tick = async () => {
    if (isTickRunning) return;
    isTickRunning = true;

    const now = Date.now();
    let hbResp = null;
    try {
      hbResp = await sendHeartbeat("idle", null);
    } catch (e) {
      console.warn("[heartbeat] failed", e.message);
    }

    const hasPendingRequest = !!hbResp?.pending_request_id;
    // Only auto-run if Continuous Sync is enabled, or if we are in RUN_ONCE mode
    const isTimeToAutoRun = (BRIDGE_STATE.isContinuous || RUN_ONCE) && (now - lastAutoRunTime) >= AUTO_SYNC_INTERVAL_MS;

    if (!hasPendingRequest && !isTimeToAutoRun) {
      isTickRunning = false;
      return;
    }

    if (hasPendingRequest) {
      logToDashboard(
        `[sync] Starting manual request (Request ID: ${hbResp.pending_request_id}, Entity: ${hbResp.pending_request_entity ?? "Full"})`,
      );
      try {
        await rosFetch("/api/sync/counterpoint/ack-request", {
          request_id: hbResp.pending_request_id,
        });
      } catch (e) {
        console.warn("[sync-request] ack failed", e.message);
      }
    } else {
      logToDashboard("[sync] Starting scheduled auto-sync");
      lastAutoRunTime = now;
    }

    let preflightSummary = null;
    try {
      preflightSummary = await runImportFirstSourcePreflight(pool);
    } catch (err) {
      console.error("[preflight] sync blocked:", err.message);
      if (hasPendingRequest) {
        try {
          await rosFetch("/api/sync/counterpoint/request/complete", {
            request_id: hbResp.pending_request_id,
            error: err.message,
          });
        } catch { /* ignore secondary error */ }
      }
      isTickRunning = false;
      return;
    }

    BRIDGE_STATE.isSyncing = true;
    BRIDGE_STATE.abortRequested = false;
    BRIDGE_STATE.totalRecordsLastRun = 0;
    const tStart = Date.now();
    pushEvent('start', null, 'Auto-sync cycle started');
    const pendingRequestEntities = hasPendingRequest && hbResp.pending_request_entity
      ? new Set([...(ENTITY_DEPENDENCIES[hbResp.pending_request_entity] || []), hbResp.pending_request_entity])
      : null;

    try {
      await startImportFirstRun(preflightSummary);
      for (const step of orderedSyncSteps) {
        if (!step.on) continue;
        if (BRIDGE_STATE.abortRequested) {
          logToDashboard('[sync] Aborted by user');
          pushEvent('abort', step.label, 'Sync aborted by user');
          break;
        }

        // If it's a manual request for a specific entity, skip others
        if (pendingRequestEntities && !pendingRequestEntities.has(step.label)) {
            continue;
        }

        BRIDGE_STATE.currentEntity = step.label;
        logToDashboard(`[${step.label}] starting sync...`);
        await sendHeartbeat("syncing", step.hb);
        await runSyncEntity(step.label, step.run);
        logToDashboard(`[${step.label}] ok`);
      }

      const cycleDur = Date.now() - tStart;
      BRIDGE_STATE.lastRunDurationMs = cycleDur;
      BRIDGE_STATE.lastRun = new Date().toISOString();
      pushEvent('complete', null, 'Auto-sync cycle complete', { durationMs: cycleDur });
      await completeImportFirstRun({
        failed: BRIDGE_STATE.abortRequested,
        errorMessage: BRIDGE_STATE.abortRequested ? "Sync aborted by user." : null,
        totals: {
          sync_summary: BRIDGE_STATE.syncSummary,
          duration_ms: cycleDur,
          requested_entity: hbResp?.pending_request_entity ?? null,
        },
      });

      if (hasPendingRequest) {
        try {
          await rosFetch("/api/sync/counterpoint/request/complete", {
            request_id: hbResp.pending_request_id,
          });
        } catch (e) {
          console.error("[sync-request] complete failed", e.message);
        }
      }
    } catch (err) {
      console.error("[sync] Loop failed:", err.message);
      await completeImportFirstRun({ failed: true, errorMessage: err.message }).catch(() => null);
      if (hasPendingRequest) {
          try {
            await rosFetch("/api/sync/counterpoint/request/complete", {
              request_id: hbResp.pending_request_id,
              error: err.message
            });
          } catch (e) { /* ignore secondary error */ }
      }
    } finally {
      BRIDGE_STATE.isSyncing = false;
      BRIDGE_STATE.currentEntity = null;
      isTickRunning = false;
      logToDashboard("[sync] pass completed");
      await sendHeartbeat("idle", null);
    }
  };

  // Only autostart if RUN_ONCE is enabled. Otherwise, stay IDLE until manual trigger or timer.
  if (RUN_ONCE) {
    await tick();
    console.info(
      "RUN_ONCE=1 - one full pass finished. Run START_BRIDGE.cmd again when you want another import (or set RUN_ONCE=0 for timed repeats).",
    );
    await pool.close();
    await waitForEnterBeforeClose();
    process.exit(0);
  } else {
    logToDashboard("Bridge started in IDLE mode. Use dashboard or wait for timer.");
  }

  console.info(
    `Polling for manual ROS requests every ${POLL_MS} ms. Scheduled sync runs only when Continuous Sync is enabled.`,
  );
  setInterval(tick, POLL_MS);
}

main().catch(async (e) => {
  console.error(e);
  if (RUN_ONCE && WAIT_AFTER_RUN_ONCE && process.stdin.isTTY) {
    await waitForEnterBeforeClose();
  }
  process.exit(1);
});
