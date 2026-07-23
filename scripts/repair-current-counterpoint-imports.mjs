#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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
const outputArg = valueAfter("--output");

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
        CONVERT(NVARCHAR(36), l.LIN_GUID) AS line_guid,
        CONVERT(NVARCHAR(36), l.LINK_LIN_GUID) AS link_line_guid,
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
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(h.TKT_NO, N'')))) AS order_ticket_no,
        CAST(t.SUB_TOT AS DECIMAL(18,4)) AS open_header_subtotal,
        CAST(t.TAX_AMT AS DECIMAL(18,4)) AS open_header_tax,
        CAST(t.TOT AS DECIMAL(18,4)) AS open_header_total,
        CAST(t.TOT_TND AS DECIMAL(18,4)) AS open_header_tender,
        CAST(l.LIN_SEQ_NO AS INT) AS open_line_sequence,
        CONVERT(NVARCHAR(36), l.LIN_GUID) AS open_line_guid,
        RTRIM(LTRIM(CONVERT(NVARCHAR(16), ISNULL(l.LIN_TYP, N'')))) AS open_line_type,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.ITEM_NO, N'')))) AS open_item_no,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.BARCOD, N'')))) AS open_barcode,
        RTRIM(LTRIM(CONVERT(NVARCHAR(255), ISNULL(l.DESCR, N'')))) AS open_description,
        CAST(ISNULL(l.QTY_SOLD, 0) AS DECIMAL(18,4)) AS open_quantity,
        CAST(ISNULL(l.QTY_SHIPPED, 0) AS DECIMAL(18,4)) AS shipped_quantity,
        CAST(ISNULL(l.REG_PRC, 0) AS DECIMAL(18,4)) AS open_regular_price,
        CAST(ISNULL(l.PRC, 0) AS DECIMAL(18,4)) AS open_price,
        CAST(ISNULL(l.CALC_PRC, 0) AS DECIMAL(18,4)) AS open_calculated_price,
        CAST(ISNULL(l.EXT_PRC, 0) AS DECIMAL(18,4)) AS open_extended_price,
        CAST(ISNULL(l.GROSS_EXT_PRC, 0) AS DECIMAL(18,4)) AS open_gross_extended_price,
        CAST(ISNULL(l.DISP_EXT_PRC, 0) AS DECIMAL(18,4)) AS open_display_extended_price,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_1_UPR, N'')))) AS open_dim_1,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_2_UPR, N'')))) AS open_dim_2,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_3_UPR, N'')))) AS open_dim_3,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), th.DOC_ID))) AS completed_doc_id,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(th.TKT_NO, N'')))) AS completed_ticket_no,
        CONVERT(VARCHAR(33), th.BUS_DAT, 126) AS completed_business_date,
        CAST(th.SUB_TOT AS DECIMAL(18,4)) AS completed_header_subtotal,
        CAST(th.TAX_AMT AS DECIMAL(18,4)) AS completed_header_tax,
        CAST(th.TOT AS DECIMAL(18,4)) AS completed_header_total,
        CAST(th.TOT_TND AS DECIMAL(18,4)) AS completed_header_tender,
        CAST(hl.LIN_SEQ_NO AS INT) AS completed_line_sequence,
        RTRIM(LTRIM(CONVERT(NVARCHAR(16), ISNULL(hl.LIN_TYP, N'')))) AS completed_line_type,
        CAST(hl.QTY_SOLD AS DECIMAL(18,4)) AS completed_quantity,
        CAST(hl.REG_PRC AS DECIMAL(18,4)) AS completed_regular_price,
        CAST(hl.PRC AS DECIMAL(18,4)) AS completed_price,
        CAST(hl.CALC_PRC AS DECIMAL(18,4)) AS completed_calculated_price,
        CAST(hl.EXT_PRC AS DECIMAL(18,4)) AS completed_extended_price,
        CAST(hl.GROSS_EXT_PRC AS DECIMAL(18,4)) AS completed_gross_extended_price,
        CAST(hl.DISP_EXT_PRC AS DECIMAL(18,4)) AS completed_display_extended_price,
        (
          SELECT SUM(ABS(CAST(all_sale.EXT_PRC AS DECIMAL(18,4))))
          FROM PS_TKT_HIST_LIN all_sale
          WHERE all_sale.DOC_ID = hl.DOC_ID
            AND all_sale.STR_ID = hl.STR_ID
            AND all_sale.STA_ID = hl.STA_ID
            AND all_sale.TKT_NO = hl.TKT_NO
            AND all_sale.LIN_TYP IN ('S', 'R')
        ) AS completed_ticket_sale_basis
      FROM PS_DOC_HDR h
      INNER JOIN PS_DOC_LIN l ON l.DOC_ID = h.DOC_ID
      OUTER APPLY (SELECT TOP 1 SUB_TOT, TOT, TAX_AMT, TOT_TND FROM PS_DOC_HDR_TOT t0
        WHERE t0.DOC_ID = h.DOC_ID
        ORDER BY CASE WHEN t0.TOT_TYP = 'O' THEN 0 ELSE 1 END, t0.TOT_TYP) t
      LEFT JOIN PS_TKT_HIST_LIN hl
        ON hl.LINK_LIN_GUID = l.LIN_GUID
       AND hl.LIN_TYP IN ('S', 'R')
      LEFT JOIN PS_TKT_HIST th
        ON th.DOC_ID = hl.DOC_ID
       AND th.STR_ID = hl.STR_ID
       AND th.STA_ID = hl.STA_ID
       AND th.TKT_NO = hl.TKT_NO
      WHERE h.DOC_ID IN (${list})
      ORDER BY h.DOC_ID, l.LIN_SEQ_NO, th.BUS_DAT, th.DOC_ID, hl.LIN_SEQ_NO
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
  const qty = numeric(line.quantity);
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
    hasExplicitExtendedPrice: ext !== null && ext !== 0,
    unit,
    original,
    discount,
    extendedBasis,
    stateTax: 0,
    localTax: 0,
  };
}

function splitExtendedTax(component, extendedTax) {
  const quantity = Math.abs(Number(component.quantity ?? 0));
  if (quantity <= 0 || extendedTax === 0) return;
  const sign = extendedTax < 0 ? -1 : 1;
  const absoluteTax = Math.abs(extendedTax);
  const stateExtended = Math.min(
    Math.round(Math.abs(component.extendedBasis) * 0.04),
    absoluteTax,
  ) * sign;
  const localExtended = (absoluteTax - Math.abs(stateExtended)) * sign;
  component.stateTax = Math.round(stateExtended / quantity);
  component.localTax = Math.round(localExtended / quantity);
}

function openSourceLine(row) {
  return sourceLineFinancials({
    quantity: row.open_quantity,
    extended_price: row.open_extended_price,
    display_extended_price: row.open_display_extended_price,
    price: row.open_price,
    calculated_price: row.open_calculated_price,
    regular_price: row.open_regular_price,
    gross_extended_price: row.open_gross_extended_price,
    item_no: row.open_item_no,
    barcode: row.open_barcode,
    description: row.open_description,
    line_type: "S",
    line_sequence: row.open_line_sequence,
    dim_1: row.open_dim_1,
    dim_2: row.open_dim_2,
    dim_3: row.open_dim_3,
  });
}

function completedSourceLine(row) {
  return sourceLineFinancials({
    quantity: row.completed_quantity,
    extended_price: row.completed_extended_price,
    display_extended_price: row.completed_display_extended_price,
    price: row.completed_price,
    calculated_price: row.completed_calculated_price,
    regular_price: row.completed_regular_price,
    gross_extended_price: row.completed_gross_extended_price,
    item_no: row.open_item_no,
    barcode: row.open_barcode,
    description: row.open_description,
    line_type: row.completed_line_type,
    line_sequence: row.completed_line_sequence,
    dim_1: row.open_dim_1,
    dim_2: row.open_dim_2,
    dim_3: row.open_dim_3,
  });
}

function buildOpenDocLifecycleFinancials(rows) {
  const lineGroups = new Map();
  const blockers = [];

  for (const row of rows) {
    const lineKey = clean(row.open_line_guid) || `sequence:${row.open_line_sequence}`;
    const group = lineGroups.get(lineKey) ?? {
      lineKey,
      row,
      openComponent: openSourceLine(row),
      completedComponents: [],
      completedKeys: new Set(),
    };
    const completedDocId = clean(row.completed_doc_id);
    const completedLineType = clean(row.completed_line_type).toUpperCase();
    if (completedDocId && completedLineType) {
      const completedKey = [
        completedDocId,
        clean(row.completed_ticket_no),
        row.completed_line_sequence,
        lineKey,
      ].join("|");
      if (!group.completedKeys.has(completedKey)) {
        group.completedKeys.add(completedKey);
        if (completedLineType !== "S") {
          blockers.push({
            reason: "linked_return_or_non_sale_ticket_line",
            open_line_guid: lineKey,
            completed_doc_id: completedDocId,
            completed_line_type: completedLineType,
          });
        } else {
          const component = completedSourceLine(row);
          if (!component.hasExplicitExtendedPrice && component.quantity !== 0) {
            blockers.push({
              reason: "completed_sale_line_has_no_explicit_extended_price",
              open_line_guid: lineKey,
              completed_doc_id: completedDocId,
              completed_line_sequence: row.completed_line_sequence,
            });
            lineGroups.set(lineKey, group);
            continue;
          }
          const ticketTax = cents(row.completed_header_tax) ?? 0;
          const ticketBasis = cents(row.completed_ticket_sale_basis) ?? 0;
          if (ticketTax !== 0 && ticketBasis <= 0) {
            blockers.push({
              reason: "completed_ticket_tax_basis_missing",
              open_line_guid: lineKey,
              completed_doc_id: completedDocId,
            });
          } else {
            const extendedTax = ticketTax === 0
              ? 0
              : Math.round((ticketTax * component.extendedBasis) / ticketBasis);
            splitExtendedTax(component, extendedTax);
          }
          component.sourceEvidence = {
            source: "ticket_history",
            completed_doc_id: completedDocId,
            completed_ticket_no: clean(row.completed_ticket_no),
            completed_business_date: row.completed_business_date ?? null,
            completed_line_sequence: row.completed_line_sequence,
            completed_line_type: completedLineType,
            header_subtotal: centsToMoney(cents(row.completed_header_subtotal) ?? 0),
            header_tax: centsToMoney(ticketTax),
            header_total: centsToMoney(cents(row.completed_header_total) ?? 0),
          };
          group.completedComponents.push(component);
        }
      }
    }
    lineGroups.set(lineKey, group);
  }

  const openComponents = [...lineGroups.values()]
    .map((group) => group.openComponent)
    .filter((component) => component.quantity > 0);
  for (const component of openComponents) {
    if (!component.hasExplicitExtendedPrice) {
      blockers.push({
        reason: "open_sale_line_has_no_explicit_extended_price",
        open_line_sequence: component.sequence,
      });
    }
  }
  allocateTax(openComponents, rows[0]?.open_header_tax);

  const sourceLines = [];
  for (const group of lineGroups.values()) {
    const openQuantity = Math.max(0, numeric(group.row.open_quantity));
    const shippedQuantity = Math.max(0, numeric(group.row.shipped_quantity));
    const completedQuantity = group.completedComponents.reduce(
      (sum, component) => sum + Math.max(0, numeric(component.quantity)),
      0,
    );
    if (completedQuantity !== shippedQuantity) {
      blockers.push({
        reason: "shipped_quantity_does_not_match_linked_sale_history",
        open_line_guid: group.lineKey,
        open_line_sequence: group.row.open_line_sequence,
        shipped_quantity: shippedQuantity,
        linked_sale_quantity: completedQuantity,
      });
      continue;
    }

    const components = [
      ...(openQuantity > 0 ? [group.openComponent] : []),
      ...group.completedComponents,
    ];
    const totalQuantity = components.reduce(
      (sum, component) => sum + Math.max(0, numeric(component.quantity)),
      0,
    );
    if (totalQuantity <= 0) {
      blockers.push({
        reason: "line_has_no_open_or_completed_sale_quantity",
        open_line_guid: group.lineKey,
        open_line_sequence: group.row.open_line_sequence,
      });
      continue;
    }

    const distinctChargedPrices = new Set(components.map((component) => component.unit));
    if (distinctChargedPrices.size !== 1) {
      blockers.push({
        reason: "mixed_charged_prices_require_line_split",
        open_line_guid: group.lineKey,
        open_line_sequence: group.row.open_line_sequence,
        charged_prices: [...distinctChargedPrices].map(centsToMoney),
      });
      continue;
    }

    const unit = components[0].unit;
    const original = Math.max(unit, ...components.map((component) => component.original));
    const stateExtended = components.reduce(
      (sum, component) =>
        sum + Math.max(0, numeric(component.quantity)) * component.stateTax,
      0,
    );
    const localExtended = components.reduce(
      (sum, component) =>
        sum + Math.max(0, numeric(component.quantity)) * component.localTax,
      0,
    );
    sourceLines.push({
      key: group.openComponent.key,
      sku: group.openComponent.sku,
      normalizedSku: group.openComponent.normalizedSku,
      description: group.openComponent.description,
      lineType: "S",
      sequence: Number(group.row.open_line_sequence ?? 0),
      quantity: totalQuantity,
      absQty: totalQuantity,
      unit,
      original,
      discount: Math.max(0, original - unit),
      extendedBasis: totalQuantity * unit,
      stateTax: Math.round(stateExtended / totalQuantity),
      localTax: Math.round(localExtended / totalQuantity),
      sourceEvidence: {
        source: "open_document_lifecycle",
        open_doc_id: clean(group.row.doc_id),
        open_ticket_no: clean(group.row.order_ticket_no),
        open_line_guid: group.lineKey,
        open_line_sequence: group.row.open_line_sequence,
        open_quantity: openQuantity,
        shipped_quantity: shippedQuantity,
        open_header_subtotal: centsToMoney(cents(group.row.open_header_subtotal) ?? 0),
        open_header_tax: centsToMoney(cents(group.row.open_header_tax) ?? 0),
        completed_sales: group.completedComponents.map(
          (component) => component.sourceEvidence,
        ),
      },
    });
  }

  const calculatedTotal = sourceLines.reduce(
    (sum, line) =>
      sum + line.quantity * (line.unit + line.stateTax + line.localTax),
    0,
  );
  const openLifecycleTotal = openComponents.length > 0
    ? cents(rows[0]?.open_header_total) ?? 0
    : 0;
  const completedTicketTotals = new Map();
  for (const row of rows) {
    const completedDocId = clean(row.completed_doc_id);
    if (!completedDocId) continue;
    completedTicketTotals.set(
      completedDocId,
      cents(row.completed_header_total) ?? 0,
    );
  }
  const lifecycleHeaderTotal = [...completedTicketTotals.values()].reduce(
    (sum, value) => sum + value,
    openLifecycleTotal,
  );
  if (calculatedTotal !== lifecycleHeaderTotal) {
    blockers.push({
      reason: "lifecycle_headers_do_not_match_financial_line_total",
      lifecycle_header_total: centsToMoney(lifecycleHeaderTotal),
      financial_line_total: centsToMoney(calculatedTotal),
    });
  }
  return {
    sourceLines,
    blockers,
    calculatedTotal: lifecycleHeaderTotal,
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
    transaction_display_id: rosLine.display_id,
    expected_before: {
      quantity,
      unit_price: centsToMoney(unitPrice),
      discount_amount: centsToMoney(discount),
      state_tax: centsToMoney(stateTax),
      local_tax: centsToMoney(localTax),
    },
    quantity: sourceLine.quantity,
    unit_price: centsToMoney(sourceLine.unit),
    discount_amount: centsToMoney(sourceLine.discount),
    state_tax: centsToMoney(sourceLine.stateTax),
    local_tax: centsToMoney(sourceLine.localTax),
    size_specs: JSON.stringify({
      counterpoint_financial_repair: "2026-07-23-lifecycle-pricing",
      counterpoint_source_doc_id: docId,
      counterpoint_line_sequence: sourceLine.sequence,
      counterpoint_quantity: sourceLine.quantity,
      counterpoint_sku: sourceLine.sku || rosLine.size_specs?.counterpoint_sku || null,
      counterpoint_item_key: sourceLine.key || rosLine.counterpoint_item_key || null,
      original_unit_price: centsToMoney(sourceLine.original),
      overridden_unit_price: centsToMoney(sourceLine.unit),
      counterpoint_discount_amount: centsToMoney(sourceLine.discount),
      discount_event_label: sourceLine.discount > 0 ? "Counterpoint imported discount" : null,
      counterpoint_lifecycle_price_evidence: sourceLine.sourceEvidence ?? null,
    }),
    source_evidence: sourceLine.sourceEvidence ?? null,
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

function buildFinancialRepairPlan(rosRows, ticketSourceByDoc, openSourceByDoc) {
  const transactions = new Map();
  for (const row of rosRows) {
    const id = row.transaction_id;
    const sourceRef = row.counterpoint_doc_ref || row.counterpoint_ticket_ref;
    const ticketRef = parseTicketRef(sourceRef);
    const group = transactions.get(id) ?? {
      transaction_id: id,
      display_id: row.display_id,
      ticket_ref: sourceRef,
      doc_id: ticketRef.docId,
      ticket_no: ticketRef.ticketNo,
      source_kind: row.counterpoint_doc_ref ? "open_doc" : "ticket_history",
      counterpoint_total: null,
      source_evidence: null,
      repair_ready: false,
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
    lifecycleBlocked: 0,
  };
  const blocked = [];
  const updatedLineIds = new Set();

  for (const txn of transactions.values()) {
    const returnEventCount = Number(txn.rows[0]?.return_event_count ?? 0);
    const refundAllocationCount = Number(
      txn.rows[0]?.refund_allocation_count ?? 0,
    );
    const allocatedTenderTotal = cents(
      txn.rows[0]?.allocated_tender_total,
    ) ?? 0;
    const storedAmountPaid = cents(txn.rows[0]?.amount_paid) ?? 0;
    if (returnEventCount > 0 || refundAllocationCount > 0) {
      skipped.lifecycleBlocked += 1;
      blocked.push({
        transaction_id: txn.transaction_id,
        display_id: txn.display_id,
        source_kind: txn.source_kind,
        doc_id: txn.doc_id,
        blockers: [{
          reason: "post_sale_return_or_refund_is_outside_price_repair_scope",
          return_event_count: returnEventCount,
          refund_allocation_count: refundAllocationCount,
        }],
      });
      continue;
    }
    if (allocatedTenderTotal !== storedAmountPaid) {
      skipped.lifecycleBlocked += 1;
      blocked.push({
        transaction_id: txn.transaction_id,
        display_id: txn.display_id,
        source_kind: txn.source_kind,
        doc_id: txn.doc_id,
        blockers: [{
          reason: "stored_paid_does_not_match_payment_allocations",
          stored_amount_paid: centsToMoney(storedAmountPaid),
          allocated_tender_total: centsToMoney(allocatedTenderTotal),
        }],
      });
      continue;
    }

    const allSourceRows = txn.source_kind === "open_doc"
      ? openSourceByDoc.get(txn.doc_id) ?? []
      : ticketSourceByDoc.get(txn.doc_id) ?? [];
    let sourceRows = allSourceRows;
    if (txn.source_kind === "ticket_history" && txn.ticket_no) {
      sourceRows = allSourceRows.filter(
        (row) => clean(row.ticket_no) === txn.ticket_no,
      );
    }
    if (sourceRows.length === 0) {
      skipped.missingCounterpointDoc += 1;
      continue;
    }

    let sourceLines;
    if (txn.source_kind === "open_doc") {
      const lifecycle = buildOpenDocLifecycleFinancials(sourceRows);
      if (lifecycle.blockers.length > 0) {
        skipped.lifecycleBlocked += 1;
        blocked.push({
          transaction_id: txn.transaction_id,
          display_id: txn.display_id,
          source_kind: txn.source_kind,
          doc_id: txn.doc_id,
          blockers: lifecycle.blockers,
        });
        continue;
      }
      sourceLines = lifecycle.sourceLines.sort((a, b) => a.sequence - b.sequence);
      txn.counterpoint_total = lifecycle.calculatedTotal;
      txn.source_evidence = {
        source: "counterpoint_open_document_plus_linked_ticket_history",
        doc_id: txn.doc_id,
        line_evidence: sourceLines.map((line) => line.sourceEvidence),
      };
    } else {
      const returnRows = sourceRows.filter(
        (row) => clean(row.line_type).toUpperCase() === "R",
      );
      if (returnRows.length > 0) {
        skipped.lifecycleBlocked += 1;
        blocked.push({
          transaction_id: txn.transaction_id,
          display_id: txn.display_id,
          source_kind: txn.source_kind,
          doc_id: txn.doc_id,
          blockers: [{ reason: "ticket_contains_return_lines" }],
        });
        continue;
      }
      const financialRows = sourceRows.filter(
        (row) => clean(row.line_type).toUpperCase() === "S",
      );
      if (financialRows.length === 0) {
        skipped.lifecycleBlocked += 1;
        blocked.push({
          transaction_id: txn.transaction_id,
          display_id: txn.display_id,
          source_kind: txn.source_kind,
          doc_id: txn.doc_id,
          blockers: [{ reason: "ticket_has_no_sale_or_return_lines" }],
        });
        continue;
      }
      const zeroPriceSaleRows = financialRows.filter(
        (row) =>
          numeric(row.quantity) !== 0 &&
          (cents(row.extended_price) ?? 0) === 0,
      );
      if (zeroPriceSaleRows.length > 0) {
        skipped.lifecycleBlocked += 1;
        blocked.push({
          transaction_id: txn.transaction_id,
          display_id: txn.display_id,
          source_kind: txn.source_kind,
          doc_id: txn.doc_id,
          blockers: [{
            reason: "ticket_sale_line_has_no_explicit_extended_price",
            line_sequences: zeroPriceSaleRows.map((row) => row.line_sequence),
          }],
        });
        continue;
      }
      sourceLines = financialRows
        .map(sourceLineFinancials)
        .sort((a, b) => a.sequence - b.sequence);
      allocateTax(sourceLines, financialRows[0]?.header_tax);
      const calculatedTotal = sourceLines.reduce(
        (sum, line) =>
          sum + line.quantity * (line.unit + line.stateTax + line.localTax),
        0,
      );
      const sourceHeaderTotal = cents(financialRows[0]?.header_total);
      if (sourceHeaderTotal === null || calculatedTotal !== sourceHeaderTotal) {
        skipped.lifecycleBlocked += 1;
        blocked.push({
          transaction_id: txn.transaction_id,
          display_id: txn.display_id,
          source_kind: txn.source_kind,
          doc_id: txn.doc_id,
          blockers: [{
            reason: "ticket_header_does_not_match_financial_sale_lines",
            header_total: centsToMoney(sourceHeaderTotal ?? 0),
            financial_line_total: centsToMoney(calculatedTotal),
          }],
        });
        continue;
      }
      txn.counterpoint_total = calculatedTotal;
      txn.source_evidence = {
        source: "counterpoint_ticket_history_financial_lines_only",
        doc_id: txn.doc_id,
        ticket_no: txn.ticket_no,
        included_line_types: ["S"],
        header_total: centsToMoney(sourceHeaderTotal),
        financial_line_total: centsToMoney(calculatedTotal),
      };
    }

    if (sourceLines.length !== txn.rows.length) {
      skipped.lineCountMismatch += 1;
      blocked.push({
        transaction_id: txn.transaction_id,
        display_id: txn.display_id,
        source_kind: txn.source_kind,
        doc_id: txn.doc_id,
        blockers: [{
          reason: "financial_source_line_count_does_not_match_ros",
          ros_line_count: txn.rows.length,
          source_line_count: sourceLines.length,
        }],
      });
      continue;
    }

    const used = new Set();
    const mapped = [];
    for (const rosLine of txn.rows) {
      const sourceLine = matchSourceLine(rosLine, sourceLines, used);
      if (!sourceLine) break;
      mapped.push([rosLine, sourceLine]);
    }
    if (mapped.length !== txn.rows.length) {
      skipped.unmatchedLines += 1;
      blocked.push({
        transaction_id: txn.transaction_id,
        display_id: txn.display_id,
        source_kind: txn.source_kind,
        doc_id: txn.doc_id,
        blockers: [{ reason: "source_lines_could_not_be_matched_exactly" }],
      });
      continue;
    }

    const quantityMismatches = mapped
      .filter(
        ([rosLine, sourceLine]) =>
          numeric(rosLine.quantity) !== numeric(sourceLine.quantity),
      )
      .map(([rosLine, sourceLine]) => ({
        line_id: rosLine.line_id,
        ros_quantity: numeric(rosLine.quantity),
        counterpoint_quantity: numeric(sourceLine.quantity),
      }));
    if (quantityMismatches.length > 0) {
      skipped.lifecycleBlocked += 1;
      blocked.push({
        transaction_id: txn.transaction_id,
        display_id: txn.display_id,
        source_kind: txn.source_kind,
        doc_id: txn.doc_id,
        blockers: [{
          reason: "quantity_mismatch_is_outside_financial_repair_scope",
          lines: quantityMismatches,
        }],
      });
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
    txn.repair_ready = true;
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
    if (!txn.repair_ready) continue;
    const lineChanged = txn.rows.some((row) => updatedLineIds.has(row.line_id));
    const total = txn.counterpoint_total ?? totals.get(txn.transaction_id);
    if (total === undefined) continue;
    const currentTotal = cents(txn.rows[0]?.total_price);
    if (!lineChanged && (txn.counterpoint_total === null || currentTotal === total)) continue;
    transactionUpdates.push({
      transaction_id: txn.transaction_id,
      transaction_display_id: txn.display_id,
      expected_before: {
        total_price: centsToMoney(currentTotal ?? 0),
        amount_paid: txn.rows[0].amount_paid,
        balance_due: txn.rows[0].balance_due,
      },
      total_price: centsToMoney(total),
      // Preserve the payment ledger.  Counterpoint's recorded tender can be
      // greater than the sale total and must not be rewritten by a price repair.
      amount_paid: txn.rows[0].amount_paid,
      balance_due: centsToMoney(Math.max(0, total - (cents(txn.rows[0].amount_paid) ?? 0))),
      source_evidence: txn.source_evidence,
    });
  }

  return {
    transactions_scanned: transactions.size,
    lineUpdates,
    transactionUpdates,
    skipped,
    blocked,
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
  if (apply && !skipFinancials) {
    throw new Error(
      "Direct Counterpoint financial repair apply is disabled. No approved production recovery workflow is currently available. Re-run without --apply for evidence only; --apply is permitted only with --skip-financials for barcode-alias repair.",
    );
  }
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  const pool = await connectCounterpoint();
  try {
    let financialPlan = {
      transactions_scanned: 0,
      lineUpdates: [],
      transactionUpdates: [],
      skipped: {},
      blocked: [],
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
        WITH return_rollup AS (
          SELECT
            transaction_id,
            COUNT(*)::bigint AS return_event_count
          FROM transaction_return_lines
          GROUP BY transaction_id
        ),
        allocation_rollup AS (
          SELECT
            pa.target_transaction_id AS transaction_id,
            COUNT(*) FILTER (
              WHERE pa.amount_allocated < 0
                 OR COALESCE(pt.metadata->>'kind', '') IN (
                   'order_refund',
                   'exchange_refund_remainder'
                 )
            )::bigint AS refund_allocation_count,
            ROUND(COALESCE(SUM(pa.amount_allocated), 0), 2)::numeric(14,2)
              AS allocated_tender_total
          FROM payment_allocations pa
          INNER JOIN payment_transactions pt ON pt.id = pa.transaction_id
          GROUP BY pa.target_transaction_id
        )
        SELECT
          t.id::text AS transaction_id,
          t.display_id,
          t.counterpoint_ticket_ref,
          t.counterpoint_doc_ref,
          t.status::text,
          t.total_price::text,
          t.amount_paid::text,
          t.balance_due::text,
          COALESCE(rr.return_event_count, 0)::bigint AS return_event_count,
          COALESCE(ar.refund_allocation_count, 0)::bigint
            AS refund_allocation_count,
          COALESCE(ar.allocated_tender_total, 0)::text
            AS allocated_tender_total,
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
          tl.is_internal,
          tl.is_fulfilled,
          tl.order_lifecycle_status::text,
          tl.fulfilled_at,
          COALESCE(tl.size_specs, '{}'::jsonb) AS size_specs
        FROM transactions t
        JOIN transaction_lines tl ON tl.transaction_id = t.id
        JOIN products p ON p.id = tl.product_id
        JOIN product_variants pv ON pv.id = tl.variant_id
        LEFT JOIN return_rollup rr ON rr.transaction_id = t.id
        LEFT JOIN allocation_rollup ar ON ar.transaction_id = t.id
        WHERE ${where.join(" AND ")}
        ORDER BY t.booked_at, t.id, tl.line_display_id NULLS LAST, tl.id
        ${limitSql}
      `);

      const ticketDocIds = [...new Set(rosRows.map((row) => parseTicketDocId(row.counterpoint_ticket_ref)).filter(Boolean))];
      const openDocIds = [...new Set(rosRows.map((row) => parseTicketDocId(row.counterpoint_doc_ref)).filter(Boolean))];
      const sourceByDoc = await fetchCounterpointTicketLines(pool, ticketDocIds);
      const openSourceByDoc = await fetchCounterpointOpenDocLines(pool, openDocIds);
      financialPlan = buildFinancialRepairPlan(
        rosRows,
        sourceByDoc,
        openSourceByDoc,
      );
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
        blocked_transactions: financialPlan.blocked.length,
      },
      aliases: {
        aliases_scanned: aliasPlan.aliases_scanned,
        alias_inserts: aliasPlan.inserts.length,
        skipped: aliasPlan.skipped,
      },
    }, null, 2));

    const manifestPayload = {
      version: 1,
      generated_at: new Date().toISOString(),
      mode: "current_counterpoint_data_repair_preview",
      direct_financial_apply_disabled: true,
      scope: {
        doc_id: docIdArg || null,
        limit: limitArg > 0 ? Math.trunc(limitArg) : null,
      },
      line_updates: financialPlan.lineUpdates,
      transaction_updates: financialPlan.transactionUpdates,
      blocked: financialPlan.blocked,
      skipped: financialPlan.skipped,
    };
    const manifestDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(manifestPayload))
      .digest("hex");
    const manifest = {
      ...manifestPayload,
      manifest_digest: manifestDigest,
    };
    if (outputArg) {
      fs.writeFileSync(path.resolve(outputArg), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`Wrote reviewed repair preview manifest: ${path.resolve(outputArg)}`);
      console.log(`Manifest SHA-256: ${manifestDigest}`);
    }

    if (docIdArg) {
      console.log("Scoped repair preview:");
      console.log(JSON.stringify({
        line_updates: financialPlan.lineUpdates.slice(0, 20),
        transaction_updates: financialPlan.transactionUpdates.slice(0, 20),
        blocked: financialPlan.blocked.slice(0, 20),
      }, null, 2));
    }

    if (apply) {
      applyRepairs(financialPlan.lineUpdates, financialPlan.transactionUpdates, aliasPlan.inserts);
      console.log("Applied repair updates.");
    } else {
      console.log(
        "Dry run only. Financial output is evidence-only and cannot be applied directly; alias-only repair may use --skip-financials --apply.",
      );
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
