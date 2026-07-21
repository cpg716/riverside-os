#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const bridgeRequire = createRequire(path.join(repoRoot, "counterpoint-bridge", "package.json"));
const sql = bridgeRequire("mssql");
const dotenv = bridgeRequire("dotenv");

const bridgeEnvPath = path.join(repoRoot, "counterpoint-bridge", ".env");
if (fs.existsSync(bridgeEnvPath)) {
  const bridgeEnv = dotenv.parse(fs.readFileSync(bridgeEnvPath));
  if (process.env.DEBUG_CP_REPAIR_ENV) {
    console.error(JSON.stringify({
      repoRoot,
      bridgeEnvPath,
      hasSqlConnectionString: Object.hasOwn(bridgeEnv, "SQL_CONNECTION_STRING"),
      keys: Object.keys(bridgeEnv).filter((key) => /SQL|COUNTERPOINT|ROS|BASE|TOKEN|CONNECTION/i.test(key)).sort(),
    }));
  }
  for (const [key, value] of Object.entries(bridgeEnv)) {
    if (!process.env[key]?.trim()) {
      process.env[key] = value;
    }
  }
}

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const skipFinancials = args.has("--skip-financials");
const skipAliases = args.has("--skip-aliases");
const docIdArg = valueAfter("--doc-id");
const limitArg = Number(valueAfter("--limit") ?? 0);

function valueAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function pgEnv() {
  return {
    ...process.env,
    PGPASSWORD: requiredEnv("PGPASSWORD"),
  };
}

function psqlArgs(extra = []) {
  return [
    "-h",
    process.env.PGHOST ?? "10.64.70.196",
    "-p",
    process.env.PGPORT ?? "5432",
    "-U",
    process.env.PGUSER ?? "postgres",
    "-d",
    process.env.PGDATABASE ?? "riverside_os",
    "-v",
    "ON_ERROR_STOP=1",
    "-X",
    ...extra,
  ];
}

function runPsql(extra, input = null, maxBuffer = 1024 * 1024 * 200) {
  const result = spawnSync("psql", psqlArgs(extra), {
    cwd: repoRoot,
    env: pgEnv(),
    input,
    encoding: "utf8",
    maxBuffer,
  });
  if (result.status !== 0) {
    throw new Error(
      `psql failed (${result.status})\n${result.stderr || ""}\n${result.stdout || ""}`,
    );
  }
  return result.stdout;
}

function pgJsonRows(query, maxBuffer = 1024 * 1024 * 200) {
  const jsonSql = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${query}) q;`;
  const stdout = runPsql(["-q", "-t", "-A", "-c", jsonSql], null, maxBuffer).trim();
  return stdout ? JSON.parse(stdout) : [];
}

function sqlString(value) {
  return String(value ?? "").replace(/'/g, "''");
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLowerCase();
}

function compact(value) {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

function cpKey(itemNo, dim1, dim2, dim3) {
  const item = clean(itemNo);
  if (!item) return "";
  return [item, clean(dim1), clean(dim2), clean(dim3)].join("|");
}

function cents(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

function centsToMoney(value) {
  return (Math.round(value) / 100).toFixed(2);
}

function numeric(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseTicketDocId(ticketRef) {
  return parseTicketRef(ticketRef).docId;
}

function parseTicketRef(ticketRef) {
  const parts = clean(ticketRef).split("|").map((part) => part.trim()).filter(Boolean);
  const docId = [...parts].reverse().find((part) => /^\d+$/.test(part)) ?? "";
  return {
    docId,
    ticketNo: parts.length >= 2 ? parts[parts.length - 2] : "",
  };
}

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(rows, columns, filename) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  }
  fs.writeFileSync(filename, `${lines.join("\n")}\n`);
}

async function connectCounterpoint() {
  const connectionString = process.env.COUNTERPOINT_SQL_CONNECTION_STRING?.trim()
    || requiredEnv("SQL_CONNECTION_STRING");
  const pool = await sql.connect(connectionString);
  pool.config.requestTimeout = Math.max(pool.config.requestTimeout ?? 0, 120_000);
  return pool;
}

async function fetchCounterpointTicketLines(pool, docIds) {
  const byDoc = new Map();
  for (const ids of chunk(docIds, 1000)) {
    const list = ids
      .map((id) => clean(id))
      .filter((id) => /^\d+$/.test(id))
      .join(", ");
    if (!list) continue;
    const result = await pool.request().query(`
      SELECT
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), h.DOC_ID))) AS doc_id,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(h.TKT_NO, N'')))) AS ticket_no,
        CAST(ISNULL(h.SUB_TOT, 0) AS DECIMAL(18,4)) AS header_subtotal,
        CAST(ISNULL(h.TAX_AMT, 0) AS DECIMAL(18,4)) AS header_tax,
        CAST(ISNULL(h.TOT, 0) AS DECIMAL(18,4)) AS header_total,
        CAST(ISNULL(h.TOT_TND, 0) AS DECIMAL(18,4)) AS header_tender,
        CAST(ISNULL(h.TOT_LIN_DISC, 0) AS DECIMAL(18,4)) AS header_line_discount,
        CAST(ISNULL(h.TOT_HDR_DISC, 0) AS DECIMAL(18,4)) AS header_discount,
        CAST(ISNULL(l.LIN_SEQ_NO, 0) AS INT) AS line_sequence,
        RTRIM(LTRIM(CONVERT(NVARCHAR(16), ISNULL(l.LIN_TYP, N'')))) AS line_type,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.ITEM_NO, N'')))) AS item_no,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.BARCOD, N'')))) AS barcode,
        RTRIM(LTRIM(CONVERT(NVARCHAR(255), ISNULL(l.DESCR, N'')))) AS description,
        CAST(ISNULL(l.QTY_SOLD, 1) AS DECIMAL(18,4)) AS quantity,
        CAST(ISNULL(l.REG_PRC, 0) AS DECIMAL(18,4)) AS regular_price,
        CAST(ISNULL(l.PRC, 0) AS DECIMAL(18,4)) AS price,
        CAST(ISNULL(l.CALC_PRC, 0) AS DECIMAL(18,4)) AS calculated_price,
        CAST(ISNULL(l.EXT_PRC, 0) AS DECIMAL(18,4)) AS extended_price,
        CAST(ISNULL(l.GROSS_EXT_PRC, 0) AS DECIMAL(18,4)) AS gross_extended_price,
        CAST(ISNULL(l.DISP_EXT_PRC, 0) AS DECIMAL(18,4)) AS display_extended_price,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_1_UPR, N'')))) AS dim_1,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_2_UPR, N'')))) AS dim_2,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_3_UPR, N'')))) AS dim_3
      FROM PS_TKT_HIST h
      INNER JOIN PS_TKT_HIST_LIN l
        ON l.DOC_ID = h.DOC_ID
       AND l.STR_ID = h.STR_ID
       AND l.STA_ID = h.STA_ID
       AND l.TKT_NO = h.TKT_NO
      WHERE h.DOC_ID IN (${list})
      ORDER BY h.DOC_ID, l.LIN_SEQ_NO
    `);
    for (const row of result.recordset ?? []) {
      const docId = clean(row.doc_id);
      const rows = byDoc.get(docId) ?? [];
      rows.push(row);
      byDoc.set(docId, rows);
    }
  }
  return byDoc;
}

async function fetchCounterpointAliases(pool) {
  const result = await pool.request().query(`
    SELECT
      RTRIM(LTRIM(CONVERT(NVARCHAR(128), ITEM_NO))) AS item_no,
      RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(DIM_1_UPR, N'')))) AS dim_1,
      RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(DIM_2_UPR, N'')))) AS dim_2,
      RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(DIM_3_UPR, N'')))) AS dim_3,
      RTRIM(LTRIM(CONVERT(NVARCHAR(128), BARCOD))) AS barcode
    FROM IM_BARCOD
    WHERE NULLIF(RTRIM(LTRIM(CONVERT(NVARCHAR(128), BARCOD))), N'') IS NOT NULL
      AND RTRIM(LTRIM(CONVERT(NVARCHAR(128), BARCOD))) LIKE N'B-%'
  `);
  return result.recordset ?? [];
}

async function fetchCounterpointOpenDocLines(pool, docIds) {
  const byDoc = new Map();
  for (const ids of chunk(docIds, 1000)) {
    const list = ids.map((id) => clean(id)).filter((id) => /^\d+$/.test(id)).join(", ");
    if (!list) continue;
    const result = await pool.request().query(`
      SELECT RTRIM(LTRIM(CONVERT(NVARCHAR(128), h.DOC_ID))) AS doc_id,
        CAST(NULL AS NVARCHAR(128)) AS ticket_no,
        CAST(t.TOT AS DECIMAL(18,4)) AS header_total,
        CAST(t.TAX_AMT AS DECIMAL(18,4)) AS header_tax,
        CAST(t.TOT_TND AS DECIMAL(18,4)) AS header_tender,
        CAST(l.LIN_SEQ_NO AS INT) AS line_sequence,
        RTRIM(LTRIM(CONVERT(NVARCHAR(16), ISNULL(l.LIN_TYP, N'')))) AS line_type,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.ITEM_NO, N'')))) AS item_no,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.BARCOD, N'')))) AS barcode,
        RTRIM(LTRIM(CONVERT(NVARCHAR(255), ISNULL(l.DESCR, N'')))) AS description,
        CAST(ISNULL(l.QTY_SOLD, 1) AS DECIMAL(18,4)) AS quantity,
        CAST(ISNULL(l.REG_PRC, 0) AS DECIMAL(18,4)) AS regular_price,
        CAST(ISNULL(l.PRC, 0) AS DECIMAL(18,4)) AS price,
        CAST(ISNULL(l.CALC_PRC, 0) AS DECIMAL(18,4)) AS calculated_price,
        CAST(ISNULL(l.EXT_PRC, 0) AS DECIMAL(18,4)) AS extended_price,
        CAST(ISNULL(l.GROSS_EXT_PRC, 0) AS DECIMAL(18,4)) AS gross_extended_price,
        CAST(ISNULL(l.DISP_EXT_PRC, 0) AS DECIMAL(18,4)) AS display_extended_price,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_1_UPR, N'')))) AS dim_1,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_2_UPR, N'')))) AS dim_2,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_3_UPR, N'')))) AS dim_3
      FROM PS_DOC_HDR h
      INNER JOIN PS_DOC_LIN l ON l.DOC_ID = h.DOC_ID
      OUTER APPLY (SELECT TOP 1 TOT, TAX_AMT, TOT_TND FROM PS_DOC_HDR_TOT t0
        WHERE t0.DOC_ID = h.DOC_ID
        ORDER BY CASE WHEN t0.TOT_TYP IN ('O','L') THEN 0 ELSE 1 END, t0.TOT_TYP) t
      WHERE h.DOC_ID IN (${list})
      ORDER BY h.DOC_ID, l.LIN_SEQ_NO
    `);
    for (const row of result.recordset ?? []) {
      const rows = byDoc.get(clean(row.doc_id)) ?? [];
      rows.push(row);
      byDoc.set(clean(row.doc_id), rows);
    }
  }
  return byDoc;
}

function sourceLineFinancials(line) {
  const qty = numeric(line.quantity) || 1;
  const absQty = Math.max(1, Math.abs(qty));
  const ext = cents(line.extended_price);
  const displayExt = cents(line.display_extended_price);
  const price = cents(line.price);
  const calc = cents(line.calculated_price);
  const regular = cents(line.regular_price);
  const grossExt = cents(line.gross_extended_price);

  const unit = ext !== null && ext !== 0
    ? Math.round(Math.abs(ext) / absQty)
    : price ?? calc ?? regular ?? 0;
  const grossUnit = grossExt !== null && grossExt !== 0
    ? Math.round(Math.abs(grossExt) / absQty)
    : null;
  const displayUnit = displayExt !== null && displayExt !== 0
    ? Math.round(Math.abs(displayExt) / absQty)
    : null;
  const original = [grossUnit, displayUnit, regular, price, calc]
    .filter((value) => value !== null && value > unit)
    .sort((a, b) => a - b)[0] ?? unit;
  const discount = Math.max(0, original - unit);
  const key = cpKey(line.item_no, line.dim_1, line.dim_2, line.dim_3);
  const extendedBasis = ext !== null && ext !== 0 ? Math.abs(ext) : Math.abs(unit * qty);

  return {
    key,
    sku: clean(line.barcode),
    normalizedSku: normalized(line.barcode),
    description: clean(line.description),
    lineType: clean(line.line_type).toUpperCase(),
    sequence: Number(line.line_sequence ?? 0),
    quantity: qty,
    absQty,
    unit,
    original,
    discount,
    extendedBasis,
    stateTax: 0,
    localTax: 0,
  };
}

function allocateTax(lines, headerTax) {
  const tax = cents(headerTax) ?? 0;
  if (tax === 0) return;

  const taxIsReturn = tax < 0;
  let eligible = lines.filter(
    (line) =>
      line.extendedBasis > 0 &&
      (taxIsReturn
        ? line.quantity < 0 && line.lineType === "R"
        : line.quantity > 0 && line.lineType === "S"),
  );
  if (eligible.length === 0) {
    eligible = lines.filter(
      (line) => line.extendedBasis > 0 && (taxIsReturn ? line.quantity < 0 : line.quantity > 0),
    );
  }
  if (eligible.length === 0) {
    eligible = lines.filter((line) => line.extendedBasis > 0 && line.quantity !== 0);
  }
  const basis = eligible.reduce((sum, line) => sum + line.extendedBasis, 0);
  if (basis <= 0) return;

  let allocated = 0;
  eligible.forEach((line, index) => {
    const lineTax = index + 1 === eligible.length
      ? tax - allocated
      : Math.round((tax * line.extendedBasis) / basis);
    allocated += lineTax;

    const totalTaxSign = lineTax < 0 ? -1 : 1;
    const absLineTax = Math.abs(lineTax);
    const stateLineTax = Math.min(Math.round(line.extendedBasis * 0.04), absLineTax) * totalTaxSign;
    const localLineTax = (absLineTax - Math.abs(stateLineTax)) * totalTaxSign;
    line.stateTax = Math.round(stateLineTax / line.quantity);
    line.localTax = Math.round(localLineTax / line.quantity);
  });
}

function matchSourceLine(rosLine, sourceLines, used) {
  const candidates = sourceLines.filter((line, idx) => !used.has(idx));
  const skuValues = [
    normalized(rosLine.sku),
    normalized(rosLine.barcode),
    normalized(rosLine.size_specs?.counterpoint_sku),
  ].filter(Boolean);
  const keyValues = [
    clean(rosLine.counterpoint_item_key),
    clean(rosLine.size_specs?.counterpoint_item_key),
  ].filter(Boolean);
  const quantity = numeric(rosLine.quantity);
  const unitPrice = cents(rosLine.unit_price) ?? null;
  const productName = compact(rosLine.product_name);
  const keyCounts = new Map();
  for (const line of sourceLines) {
    if (!line.key) continue;
    keyCounts.set(line.key, (keyCounts.get(line.key) ?? 0) + 1);
  }

  let best = null;
  let bestScore = 0;
  for (const line of candidates) {
    let score = 0;
    if (line.normalizedSku && skuValues.includes(line.normalizedSku)) score += 100;
    if (line.key && keyValues.includes(line.key)) score += keyCounts.get(line.key) === 1 ? 80 : 15;
    if (unitPrice !== null && unitPrice === line.unit) score += 60;
    if (unitPrice !== null && unitPrice === line.original) score += 20;
    if (Number(line.quantity) === quantity) score += 30;
    if (compact(line.description) === productName) score += 10;

    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }

  if (!best) return null;
  const idx = sourceLines.indexOf(best);
  used.add(idx);
  return best;
}

function plannedLineUpdate(rosLine, sourceLine, docId) {
  const quantity = numeric(rosLine.quantity);
  const unitPrice = cents(rosLine.unit_price) ?? 0;
  const discount = cents(rosLine.discount_amount) ?? 0;
  const stateTax = cents(rosLine.state_tax) ?? 0;
  const localTax = cents(rosLine.local_tax) ?? 0;
  const changed =
    quantity !== sourceLine.quantity ||
    unitPrice !== sourceLine.unit ||
    discount !== sourceLine.discount ||
    stateTax !== sourceLine.stateTax ||
    localTax !== sourceLine.localTax;
  if (!changed) return null;

  return {
    line_id: rosLine.line_id,
    transaction_id: rosLine.transaction_id,
    quantity: sourceLine.quantity,
    unit_price: centsToMoney(sourceLine.unit),
    discount_amount: centsToMoney(sourceLine.discount),
    state_tax: centsToMoney(sourceLine.stateTax),
    local_tax: centsToMoney(sourceLine.localTax),
    size_specs: JSON.stringify({
      counterpoint_financial_repair: "2026-07-07",
      counterpoint_source_doc_id: docId,
      counterpoint_line_sequence: sourceLine.sequence,
      counterpoint_quantity: sourceLine.quantity,
      counterpoint_sku: sourceLine.sku || rosLine.size_specs?.counterpoint_sku || null,
      counterpoint_item_key: sourceLine.key || rosLine.counterpoint_item_key || null,
      original_unit_price: centsToMoney(sourceLine.original),
      overridden_unit_price: centsToMoney(sourceLine.unit),
      counterpoint_discount_amount: centsToMoney(sourceLine.discount),
      discount_event_label: sourceLine.discount > 0 ? "Counterpoint imported discount" : null,
    }),
  };
}

function calculateTransactionTotals(linesByTransaction) {
  const totals = new Map();
  for (const [transactionId, lines] of linesByTransaction.entries()) {
    let total = 0;
    for (const line of lines) {
      const quantity = Number(line.quantity ?? 0);
      const nextQuantity = Number(line.next_quantity ?? quantity);
      const unit = cents(line.next_unit_price ?? line.unit_price) ?? 0;
      const state = cents(line.next_state_tax ?? line.state_tax) ?? 0;
      const local = cents(line.next_local_tax ?? line.local_tax) ?? 0;
      total += nextQuantity * (unit + state + local);
    }
    totals.set(transactionId, total);
  }
  return totals;
}

function buildFinancialRepairPlan(rosRows, sourceByDoc) {
  const transactions = new Map();
  for (const row of rosRows) {
    const id = row.transaction_id;
    const ticketRef = parseTicketRef(row.counterpoint_ticket_ref || row.counterpoint_doc_ref);
    const group = transactions.get(id) ?? {
      transaction_id: id,
      ticket_ref: row.counterpoint_ticket_ref || row.counterpoint_doc_ref,
      doc_id: ticketRef.docId,
      ticket_no: ticketRef.ticketNo,
      counterpoint_total: null,
      rows: [],
    };
    group.rows.push(row);
    transactions.set(id, group);
  }

  const lineUpdates = [];
  const skipped = {
    missingCounterpointDoc: 0,
    lineCountMismatch: 0,
    unmatchedLines: 0,
  };
  const updatedLineIds = new Set();

  for (const txn of transactions.values()) {
    const allSourceRows = sourceByDoc.get(txn.doc_id) ?? [];
    let sourceRows = txn.ticket_no
      ? allSourceRows.filter((row) => clean(row.ticket_no) === txn.ticket_no)
      : allSourceRows;
    if (sourceRows.length === 0 && allSourceRows.length > 0) {
      sourceRows = allSourceRows;
    }
    if (sourceRows.length === 0) {
      skipped.missingCounterpointDoc += 1;
      continue;
    }
    const sourceHeaderTotal = cents(sourceRows[0]?.header_total);
    if (sourceHeaderTotal !== null && sourceHeaderTotal !== 0) {
      txn.counterpoint_total = sourceHeaderTotal;
    }
    if (sourceRows.length !== txn.rows.length) {
      skipped.lineCountMismatch += 1;
      continue;
    }

    const sourceLines = sourceRows.map(sourceLineFinancials).sort((a, b) => a.sequence - b.sequence);
    allocateTax(sourceLines, sourceRows[0]?.header_tax);

    const used = new Set();
    const mapped = [];
    for (const rosLine of txn.rows) {
      const sourceLine = matchSourceLine(rosLine, sourceLines, used);
      if (!sourceLine) break;
      mapped.push([rosLine, sourceLine]);
    }
    if (mapped.length !== txn.rows.length) {
      skipped.unmatchedLines += 1;
      continue;
    }

    for (const [rosLine, sourceLine] of mapped) {
      const update = plannedLineUpdate(rosLine, sourceLine, txn.doc_id);
      if (!update) continue;
      lineUpdates.push(update);
      updatedLineIds.add(rosLine.line_id);
      rosLine.next_quantity = update.quantity;
      rosLine.next_unit_price = update.unit_price;
      rosLine.next_state_tax = update.state_tax;
      rosLine.next_local_tax = update.local_tax;
    }
  }

  const rowsByTransaction = new Map();
  for (const row of rosRows) {
    const group = rowsByTransaction.get(row.transaction_id) ?? [];
    group.push(row);
    rowsByTransaction.set(row.transaction_id, group);
  }
  const totals = calculateTransactionTotals(rowsByTransaction);
  const transactionUpdates = [];
  for (const txn of transactions.values()) {
    const lineChanged = txn.rows.some((row) => updatedLineIds.has(row.line_id));
    const total = txn.counterpoint_total ?? totals.get(txn.transaction_id);
    if (total === undefined) continue;
    const currentTotal = cents(txn.rows[0]?.total_price);
    if (!lineChanged && (txn.counterpoint_total === null || currentTotal === total)) continue;
    transactionUpdates.push({
      transaction_id: txn.transaction_id,
      total_price: centsToMoney(total),
      // Preserve the payment ledger.  Counterpoint's recorded tender can be
      // greater than the sale total and must not be rewritten by a price repair.
      amount_paid: txn.rows[0].amount_paid,
      balance_due: centsToMoney(Math.max(0, total - (cents(txn.rows[0].amount_paid) ?? 0))),
    });
  }

  return {
    transactions_scanned: transactions.size,
    lineUpdates,
    transactionUpdates,
    skipped,
  };
}

function buildAliasRepairPlan(cpAliasRows, rosVariants, existingAliases) {
  const variantsByKey = new Map();
  const duplicateKeys = new Set();
  for (const variant of rosVariants) {
    const key = clean(variant.counterpoint_item_key);
    if (!key) continue;
    if (variantsByKey.has(key)) duplicateKeys.add(key);
    else variantsByKey.set(key, variant);
  }
  for (const key of duplicateKeys) variantsByKey.delete(key);

  const existingByAlias = new Map(
    existingAliases.map((row) => [normalized(row.alias_value), row]),
  );

  const inserts = [];
  const skipped = {
    noVariantKey: 0,
    duplicateVariantKey: duplicateKeys.size,
    existingSame: 0,
    existingConflict: 0,
    alreadyPrimarySku: 0,
  };

  const seen = new Set();
  for (const row of cpAliasRows) {
    const alias = clean(row.barcode);
    const normAlias = normalized(alias);
    const key = cpKey(row.item_no, row.dim_1, row.dim_2, row.dim_3);
    if (!alias || !normAlias || seen.has(normAlias)) continue;
    seen.add(normAlias);
    if (!key || duplicateKeys.has(key)) {
      skipped.duplicateVariantKey += 1;
      continue;
    }
    const variant = variantsByKey.get(key);
    if (!variant) {
      skipped.noVariantKey += 1;
      continue;
    }
    if ([variant.sku, variant.barcode].map(normalized).includes(normAlias)) {
      skipped.alreadyPrimarySku += 1;
      continue;
    }
    const existing = existingByAlias.get(normAlias);
    if (existing) {
      if (existing.variant_id === variant.id) skipped.existingSame += 1;
      else skipped.existingConflict += 1;
      continue;
    }
    inserts.push({
      variant_id: variant.id,
      alias_value: alias,
      alias_type: "counterpoint_b_sku",
      source_system: "counterpoint_sql_repair",
      source_file_name: "IM_BARCOD live SQL",
      counterpoint_item_key: key,
      family_key: clean(row.item_no),
      match_method: "counterpoint_item_key",
      status: "active",
    });
  }

  return {
    aliases_scanned: cpAliasRows.length,
    inserts,
    skipped,
  };
}

function applyRepairs(lineUpdates, transactionUpdates, aliasInserts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ros-cp-repair-"));
  const lineCsv = path.join(dir, "line_updates.csv");
  const txnCsv = path.join(dir, "transaction_updates.csv");
  const aliasCsv = path.join(dir, "alias_inserts.csv");

  writeCsv(
    lineUpdates,
    ["line_id", "transaction_id", "quantity", "unit_price", "discount_amount", "state_tax", "local_tax", "size_specs"],
    lineCsv,
  );
  writeCsv(
    transactionUpdates,
    ["transaction_id", "total_price", "amount_paid", "balance_due"],
    txnCsv,
  );
  writeCsv(
    aliasInserts,
    [
      "variant_id",
      "alias_value",
      "alias_type",
      "source_system",
      "source_file_name",
      "counterpoint_item_key",
      "family_key",
      "match_method",
      "status",
    ],
    aliasCsv,
  );

  const sqlText = `
BEGIN;

SELECT pg_catalog.set_config('riverside.suppress_booking_event', 'true', true);

CREATE TEMP TABLE cp_line_repair (
  line_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL,
  quantity numeric NOT NULL,
  unit_price numeric NOT NULL,
  discount_amount numeric NOT NULL,
  state_tax numeric NOT NULL,
  local_tax numeric NOT NULL,
  size_specs jsonb NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE cp_transaction_repair (
  transaction_id uuid PRIMARY KEY,
  total_price numeric NOT NULL,
  amount_paid numeric NOT NULL,
  balance_due numeric NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE cp_alias_repair (
  variant_id uuid NOT NULL,
  alias_value text NOT NULL,
  alias_type text NOT NULL,
  source_system text NOT NULL,
  source_file_name text NOT NULL,
  counterpoint_item_key text,
  family_key text,
  match_method text NOT NULL,
  status text NOT NULL
) ON COMMIT DROP;

\\copy cp_line_repair FROM '${lineCsv.replace(/'/g, "''")}' WITH (FORMAT csv, HEADER true)
\\copy cp_transaction_repair FROM '${txnCsv.replace(/'/g, "''")}' WITH (FORMAT csv, HEADER true)
\\copy cp_alias_repair FROM '${aliasCsv.replace(/'/g, "''")}' WITH (FORMAT csv, HEADER true)

UPDATE transaction_lines tl
SET unit_price = r.unit_price,
    quantity = r.quantity,
    discount_amount = r.discount_amount,
    state_tax = r.state_tax,
    local_tax = r.local_tax,
    size_specs = COALESCE(tl.size_specs, '{}'::jsonb) || r.size_specs
FROM cp_line_repair r
WHERE tl.id = r.line_id
  AND tl.transaction_id = r.transaction_id;

UPDATE transactions t
SET total_price = r.total_price,
    amount_paid = GREATEST(0, r.amount_paid),
    balance_due = r.balance_due,
    status = 'fulfilled'::order_status,
    fulfilled_at = COALESCE(t.fulfilled_at, t.booked_at),
    metadata = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object('counterpoint_financial_repair', '2026-07-07')
FROM cp_transaction_repair r
WHERE t.id = r.transaction_id
  AND COALESCE(t.is_counterpoint_import, false)
  AND (t.counterpoint_ticket_ref IS NOT NULL OR t.counterpoint_doc_ref IS NOT NULL);

INSERT INTO product_variant_barcode_aliases (
  variant_id,
  alias_value,
  alias_type,
  source_system,
  source_file_name,
  counterpoint_item_key,
  family_key,
  match_method,
  status
)
SELECT
  r.variant_id,
  r.alias_value,
  r.alias_type,
  r.source_system,
  r.source_file_name,
  r.counterpoint_item_key,
  r.family_key,
  r.match_method,
  r.status
FROM cp_alias_repair r
WHERE NOT EXISTS (
  SELECT 1
  FROM product_variant_barcode_aliases a
  WHERE a.status = 'active'
    AND a.normalized_alias = lower(trim(r.alias_value))
)
ON CONFLICT DO NOTHING;

COMMIT;
`;

  try {
    return runPsql(["-q"], sqlText, 1024 * 1024 * 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function summarizeMoneyDeltas(lineUpdates) {
  const priceChanges = lineUpdates.filter((row) => row.unit_price !== undefined).length;
  const taxChanges = lineUpdates.filter(
    (row) => Number(row.state_tax) !== 0 || Number(row.local_tax) !== 0,
  ).length;
  return { priceChanges, taxChanges };
}

async function main() {
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  const pool = await connectCounterpoint();
  try {
    let financialPlan = {
      transactions_scanned: 0,
      lineUpdates: [],
      transactionUpdates: [],
      skipped: {},
    };
    let aliasPlan = {
      aliases_scanned: 0,
      inserts: [],
      skipped: {},
    };

    if (!skipFinancials) {
      const where = [
        "COALESCE(t.is_counterpoint_import, false)",
        "(t.counterpoint_ticket_ref IS NOT NULL OR t.counterpoint_doc_ref IS NOT NULL)",
      ];
      if (docIdArg) {
        where.push(`(t.counterpoint_ticket_ref LIKE '%${sqlString(docIdArg)}%' OR t.counterpoint_doc_ref LIKE '%${sqlString(docIdArg)}%')`);
      }
      const limitSql = limitArg > 0 ? ` LIMIT ${Math.trunc(limitArg)}` : "";
      const rosRows = pgJsonRows(`
        SELECT
          t.id::text AS transaction_id,
          t.counterpoint_ticket_ref,
          t.counterpoint_doc_ref,
          t.total_price::text,
          t.amount_paid::text,
          t.balance_due::text,
          tl.id::text AS line_id,
          tl.product_id::text AS product_id,
          tl.variant_id::text AS variant_id,
          p.name AS product_name,
          pv.sku,
          pv.barcode,
          pv.counterpoint_item_key,
          tl.quantity,
          tl.unit_price::text,
          tl.discount_amount::text,
          tl.state_tax::text,
          tl.local_tax::text,
          COALESCE(tl.size_specs, '{}'::jsonb) AS size_specs
        FROM transactions t
        JOIN transaction_lines tl ON tl.transaction_id = t.id
        JOIN products p ON p.id = tl.product_id
        JOIN product_variants pv ON pv.id = tl.variant_id
        WHERE ${where.join(" AND ")}
        ORDER BY t.booked_at, t.id, tl.line_display_id NULLS LAST, tl.id
        ${limitSql}
      `);

      const ticketDocIds = [...new Set(rosRows.map((row) => parseTicketDocId(row.counterpoint_ticket_ref)).filter(Boolean))];
      const openDocIds = [...new Set(rosRows.map((row) => parseTicketDocId(row.counterpoint_doc_ref)).filter(Boolean))];
      const sourceByDoc = await fetchCounterpointTicketLines(pool, ticketDocIds);
      const openSourceByDoc = await fetchCounterpointOpenDocLines(pool, openDocIds);
      for (const [docId, rows] of openSourceByDoc) sourceByDoc.set(docId, rows);
      financialPlan = buildFinancialRepairPlan(rosRows, sourceByDoc);
    }

    if (!skipAliases) {
      const cpAliasRows = await fetchCounterpointAliases(pool);
      const rosVariants = pgJsonRows(`
        SELECT id::text, sku, barcode, counterpoint_item_key
        FROM product_variants
        WHERE counterpoint_item_key IS NOT NULL
      `);
      const existingAliases = pgJsonRows(`
        SELECT variant_id::text, alias_value, alias_type, source_system, counterpoint_item_key, match_method
        FROM product_variant_barcode_aliases
        WHERE status = 'active'
      `);
      aliasPlan = buildAliasRepairPlan(cpAliasRows, rosVariants, existingAliases);
    }

    const moneySummary = summarizeMoneyDeltas(financialPlan.lineUpdates);
    console.log(JSON.stringify({
      financials: {
        transactions_scanned: financialPlan.transactions_scanned,
        line_updates: financialPlan.lineUpdates.length,
        transaction_updates: financialPlan.transactionUpdates.length,
        price_changes: moneySummary.priceChanges,
        tax_changes: moneySummary.taxChanges,
        skipped: financialPlan.skipped,
      },
      aliases: {
        aliases_scanned: aliasPlan.aliases_scanned,
        alias_inserts: aliasPlan.inserts.length,
        skipped: aliasPlan.skipped,
      },
    }, null, 2));

    if (docIdArg && financialPlan.lineUpdates.length > 0) {
      console.log("Sample line updates:");
      console.log(JSON.stringify(financialPlan.lineUpdates.slice(0, 10), null, 2));
    }

    if (apply) {
      applyRepairs(financialPlan.lineUpdates, financialPlan.transactionUpdates, aliasPlan.inserts);
      console.log("Applied repair updates.");
    } else {
      console.log("Dry run only. Re-run with --apply to update ROS.");
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
