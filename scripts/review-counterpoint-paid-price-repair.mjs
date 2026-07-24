#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const bridgeRequire = createRequire(
  path.join(repoRoot, "counterpoint-bridge", "package.json"),
);
const sql = bridgeRequire("mssql");
const outputPath = valueAfter("--output");
const includeBlockedDetails = process.argv.includes("--include-blocked-details");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function psqlArgs(extra = []) {
  return [
    "-h",
    requiredEnv("PGHOST"),
    "-p",
    process.env.PGPORT ?? "5432",
    "-U",
    requiredEnv("PGUSER"),
    "-d",
    requiredEnv("PGDATABASE"),
    "-v",
    "ON_ERROR_STOP=1",
    "-X",
    ...extra,
  ];
}

function pgJsonRows(query) {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${query}) q;`;
  const result = spawnSync("psql", psqlArgs(["-q", "-t", "-A", "-c", wrapped]), {
    cwd: repoRoot,
    env: { ...process.env, PGPASSWORD: requiredEnv("PGPASSWORD") },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 300,
  });
  if (result.status !== 0) {
    throw new Error(`psql failed\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim() || "[]");
}

function counterpointPool(connectionString) {
  const parsed = sql.ConnectionPool.parseConnectionString(connectionString);
  if (!parsed.server) {
    throw new Error("Counterpoint SQL connection string is missing its server");
  }
  const options = { ...(parsed.options ?? {}) };
  if (
    net.isIP(parsed.server) !== 0 &&
    options.trustServerCertificate === true
  ) {
    options.serverName =
      process.env.SQL_TLS_SERVERNAME?.trim() || "RMSSVR";
  }
  return new sql.ConnectionPool({
    ...parsed,
    options,
    connectionTimeout: 30_000,
    requestTimeout: 180_000,
  });
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLowerCase();
}

function cents(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function money(value) {
  return (Math.round(value) / 100).toFixed(2);
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function cpKey(itemNo, dim1, dim2, dim3) {
  const item = clean(itemNo);
  return item ? [item, clean(dim1), clean(dim2), clean(dim3)].join("|") : "";
}

function parseReference(reference) {
  const parts = clean(reference)
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    docId: [...parts].reverse().find((part) => /^\d+$/.test(part)) ?? "",
    ticketNo: [...parts].reverse().find((part) => /^[A-Z]+-\d+(?:-\d+)?$/i.test(part)) ?? "",
  };
}

function orderBase(reference) {
  return clean(reference).match(/\bO-\d+\b/i)?.[0]?.toUpperCase() ?? "";
}

function sourceLine(row, prefix = "") {
  const get = (name) => row[`${prefix}${name}`];
  const quantity = number(get("quantity"));
  const absoluteQuantity = Math.max(1, Math.abs(quantity));
  const extended = cents(get("extended_price"));
  if (extended === null) {
    throw new Error("Counterpoint EXT_PRC is unavailable for a reviewed line");
  }
  const unit = Math.round(Math.abs(extended) / absoluteQuantity);
  const regular = cents(get("regular_price"));
  const price = cents(get("price"));
  const calculated = cents(get("calculated_price"));
  const grossExtended = cents(get("gross_extended_price"));
  const grossUnit =
    grossExtended === null
      ? null
      : Math.round(Math.abs(grossExtended) / absoluteQuantity);
  const original = Math.max(
    unit,
    ...[regular, price, calculated, grossUnit].filter(
      (candidate) => candidate !== null,
    ),
  );
  return {
    key: cpKey(get("item_no"), get("dim_1"), get("dim_2"), get("dim_3")),
    sku: clean(get("barcode")),
    taxCategory: clean(
      get("normal_tax_category") || get("tax_category"),
    ).toUpperCase(),
    sequence: Number(get("line_sequence") ?? 0),
    lineType: clean(get("line_type")).toUpperCase(),
    linkGuid: clean(get("link_line_guid")),
    lineGuid: clean(get("line_guid")),
    quantity,
    unit,
    original,
    discount: Math.max(0, original - unit),
    extendedBasis: Math.abs(extended),
    stateTax: 0,
    localTax: 0,
    evidence: {
      counterpoint_doc_id: clean(row.doc_id),
      counterpoint_ticket_no: clean(row.ticket_no),
      counterpoint_ticket_at: clean(row.ticket_at) || null,
      counterpoint_line_sequence: Number(get("line_sequence") ?? 0),
      counterpoint_line_type: clean(get("line_type")).toUpperCase(),
      counterpoint_line_guid: clean(get("line_guid")) || null,
      counterpoint_link_line_guid: clean(get("link_line_guid")) || null,
      counterpoint_extended_price: money(extended),
      counterpoint_regular_price: money(regular ?? original),
      counterpoint_tax_category:
        clean(get("normal_tax_category") || get("tax_category")) || null,
    },
  };
}

function ruleComponents(components, ruleCode, taxableBasis) {
  const normalizedRule = clean(ruleCode).toUpperCase();
  const eligible = components.filter(
    (component) => component.quantity > 0 && component.extendedBasis > 0,
  );
  let matched = eligible;
  if (
    normalizedRule.includes("UNDER110") ||
    normalizedRule.includes("BELOW $110")
  ) {
    matched = eligible.filter(
      (component) =>
        component.taxCategory === "CLOTHING" && component.unit < 11_000,
    );
  } else if (
    normalizedRule.includes("OVER110") ||
    normalizedRule.includes("OVER $110")
  ) {
    matched = eligible.filter(
      (component) =>
        component.taxCategory === "CLOTHING" && component.unit >= 11_000,
    );
  } else if (normalizedRule.includes("BELOW $55")) {
    matched = eligible.filter(
      (component) =>
        component.taxCategory === "CLOTHING" && component.unit < 5_500,
    );
  } else if (normalizedRule.includes("OVER $55")) {
    matched = eligible.filter(
      (component) =>
        component.taxCategory === "CLOTHING" && component.unit >= 5_500,
    );
  } else if (normalizedRule === "TAX") {
    matched = eligible.filter(
      (component) => component.taxCategory !== "CLOTHING",
    );
  }
  const matchedBasis = matched.reduce(
    (sum, component) => sum + component.extendedBasis,
    0,
  );
  if (matchedBasis !== taxableBasis) {
    throw new Error(
      `Counterpoint tax rule ${normalizedRule || "(blank)"} has taxable basis ${money(taxableBasis)}, but matched lines total ${money(matchedBasis)}`,
    );
  }
  return matched;
}

function allocateTaxField(components, totalTax, field, taxEvidence) {
  if (totalTax === 0) return;
  const basis = components.reduce(
    (sum, component) => sum + component.extendedBasis,
    0,
  );
  if (basis <= 0) {
    throw new Error("Counterpoint tax authority has no charged line basis");
  }
  let allocatedExtended = 0;
  for (const [index, component] of components.entries()) {
    const extendedTax =
      index + 1 === components.length
        ? totalTax - allocatedExtended
        : Math.round((totalTax * component.extendedBasis) / basis);
    allocatedExtended += extendedTax;
    component[field] += Math.round(
      extendedTax / Math.abs(component.quantity),
    );
  }

  const projectedTax = components.reduce(
    (sum, component) =>
      sum + Math.abs(component.quantity) * component[field],
    0,
  );
  let roundingDelta = totalTax - projectedTax;
  const singleUnitLines = components
    .filter((component) => Math.abs(component.quantity) === 1)
    .sort((left, right) => right.extendedBasis - left.extendedBasis);
  for (const component of singleUnitLines) {
    if (roundingDelta === 0) break;
    const originalDelta = roundingDelta;
    if (roundingDelta > 0) {
      component[field] += roundingDelta;
      roundingDelta = 0;
    } else {
      const reduction = Math.min(
        component[field],
        Math.abs(roundingDelta),
      );
      component[field] -= reduction;
      roundingDelta += reduction;
    }
    const appliedDelta = originalDelta - roundingDelta;
    if (appliedDelta !== 0) {
      component.evidence.counterpoint_tax_rounding_adjustments ??= [];
      component.evidence.counterpoint_tax_rounding_adjustments.push({
        ...taxEvidence,
        field,
        amount: money(appliedDelta),
      });
    }
  }
  if (roundingDelta !== 0) {
    throw new Error(
      `Counterpoint ${field} cannot be represented by per-unit line tax; residual ${money(roundingDelta)}`,
    );
  }
}

function allocateTax(components, headerTax, taxRows) {
  const tax = cents(headerTax) ?? 0;
  if (tax === 0) return;
  const reviewedTaxRows = (taxRows ?? []).filter(
    (row) => (cents(row.tax_amount) ?? 0) !== 0,
  );
  const taxRowTotal = reviewedTaxRows.reduce(
    (sum, row) => sum + (cents(row.tax_amount) ?? 0),
    0,
  );
  if (taxRowTotal !== tax) {
    throw new Error(
      `Counterpoint tax-authority rows total ${money(taxRowTotal)}, but the header tax is ${money(tax)}`,
    );
  }
  for (const row of reviewedTaxRows) {
    const combinedTax = cents(row.tax_amount) ?? 0;
    const taxableBasis = cents(row.taxable_line_amount) ?? 0;
    if (combinedTax < 0 || taxableBasis <= 0) {
      throw new Error("Counterpoint sale tax authority contains a negative amount");
    }
    const matched = ruleComponents(
      components,
      row.rule_code,
      taxableBasis,
    );
    const normalizedRule = clean(row.rule_code).toUpperCase();
    const stateExempt =
      normalizedRule.includes("UNDER110") ||
      normalizedRule.includes("BELOW $110") ||
      normalizedRule.includes("BELOW $55");
    const stateTax = stateExempt
      ? 0
      : Math.min(Math.round(taxableBasis * 0.04), combinedTax);
    const localTax = combinedTax - stateTax;
    const evidence = {
      counterpoint_tax_authority: clean(row.auth_code),
      counterpoint_tax_rule: clean(row.rule_code),
      counterpoint_taxable_basis: money(taxableBasis),
      counterpoint_authority_tax: money(combinedTax),
    };
    allocateTaxField(matched, stateTax, "stateTax", evidence);
    allocateTaxField(matched, localTax, "localTax", evidence);
    for (const component of matched) {
      component.evidence.counterpoint_tax_rules ??= [];
      component.evidence.counterpoint_tax_rules.push(evidence);
    }
  }
}

async function fetchDocumentTaxRows(pool, tableName, docIds) {
  if (!["PS_TKT_HIST_TAX", "PS_DOC_TAX"].includes(tableName)) {
    throw new Error("unsupported Counterpoint tax table");
  }
  const rows = [];
  for (const ids of chunks([...new Set(docIds)], 800)) {
    const values = ids.filter((id) => /^\d+$/.test(id)).join(",");
    if (!values) continue;
    const result = await pool.request().query(`
      SELECT
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), DOC_ID))) AS doc_id,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), AUTH_COD))) AS auth_code,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), RUL_COD))) AS rule_code,
        CAST(TXBL_LIN_AMT AS DECIMAL(18,4)) AS taxable_line_amount,
        CAST(TAX_AMT AS DECIMAL(18,4)) AS tax_amount
      FROM ${tableName}
      WHERE DOC_ID IN (${values})
        AND TAX_AMT <> 0
      ORDER BY DOC_ID, AUTH_COD, RUL_COD
    `);
    rows.push(...(result.recordset ?? []));
  }
  return rows;
}

function taxRowsByDocument(rows) {
  const byDocument = new Map();
  for (const row of rows) {
    const docId = clean(row.doc_id);
    const documentRows = byDocument.get(docId) ?? [];
    documentRows.push(row);
    byDocument.set(docId, documentRows);
  }
  return byDocument;
}

async function fetchTicketHistory(pool, docIds, orderBases) {
  const rows = [];
  const seen = new Set();
  const select = `
    SELECT
      RTRIM(LTRIM(CONVERT(NVARCHAR(128), h.DOC_ID))) AS doc_id,
      RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(h.TKT_NO, N'')))) AS ticket_no,
      CONVERT(varchar(33), h.TKT_DT, 126) + 'Z' AS ticket_at,
      CAST(ISNULL(h.SUB_TOT, 0) AS DECIMAL(18,4)) AS header_subtotal,
      CAST(ISNULL(h.TAX_AMT, 0) AS DECIMAL(18,4)) AS header_tax,
      CAST(ISNULL(h.TOT, 0) AS DECIMAL(18,4)) AS header_total,
      CAST(ISNULL(h.TOT_TND, 0) AS DECIMAL(18,4)) AS header_tender,
      CAST(ISNULL(l.LIN_SEQ_NO, 0) AS INT) AS line_sequence,
      RTRIM(LTRIM(CONVERT(NVARCHAR(16), ISNULL(l.LIN_TYP, N'')))) AS line_type,
      RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.ITEM_NO, N'')))) AS item_no,
      RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.BARCOD, N'')))) AS barcode,
      CAST(ISNULL(l.QTY_SOLD, 0) AS DECIMAL(18,4)) AS quantity,
      CAST(l.REG_PRC AS DECIMAL(18,4)) AS regular_price,
      CAST(l.PRC AS DECIMAL(18,4)) AS price,
      CAST(l.CALC_PRC AS DECIMAL(18,4)) AS calculated_price,
      CAST(l.EXT_PRC AS DECIMAL(18,4)) AS extended_price,
      CAST(l.GROSS_EXT_PRC AS DECIMAL(18,4)) AS gross_extended_price,
      CAST(l.DISP_EXT_PRC AS DECIMAL(18,4)) AS display_extended_price,
      RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.TAX_CATEG, N'')))) AS tax_category,
      RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.NORM_TAX_CATEG, N'')))) AS normal_tax_category,
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
  `;
  const append = (recordset) => {
    for (const row of recordset ?? []) {
      const key = `${clean(row.doc_id)}|${clean(row.ticket_no)}|${row.line_sequence}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
  };
  for (const ids of chunks([...new Set(docIds)], 800)) {
    const values = ids.filter((id) => /^\d+$/.test(id)).join(",");
    if (!values) continue;
    append((await pool.request().query(`${select} WHERE h.DOC_ID IN (${values})`)).recordset);
  }
  for (const bases of chunks([...new Set(orderBases)], 80)) {
    const predicates = bases
      .map(
        (base) =>
          `RTRIM(LTRIM(CONVERT(NVARCHAR(128), h.TKT_NO))) LIKE N'${base.replaceAll("'", "''")}-%'`,
      )
      .join(" OR ");
    if (!predicates) continue;
    append((await pool.request().query(`${select} WHERE ${predicates}`)).recordset);
  }
  return rows;
}

async function fetchOpenDocuments(pool, docIds) {
  const rows = [];
  for (const ids of chunks([...new Set(docIds)], 800)) {
    const values = ids.filter((id) => /^\d+$/.test(id)).join(",");
    if (!values) continue;
    const result = await pool.request().query(`
      SELECT
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), h.DOC_ID))) AS doc_id,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(h.TKT_NO, N'')))) AS ticket_no,
        CAST(ISNULL(t.SUB_TOT, 0) AS DECIMAL(18,4)) AS header_subtotal,
        CAST(ISNULL(t.TAX_AMT, 0) AS DECIMAL(18,4)) AS header_tax,
        CAST(ISNULL(t.TOT, 0) AS DECIMAL(18,4)) AS header_total,
        CAST(ISNULL(t.TOT_TND, 0) AS DECIMAL(18,4)) AS header_tender,
        CAST(ISNULL(l.LIN_SEQ_NO, 0) AS INT) AS line_sequence,
        CAST(ISNULL(l.QTY_SOLD, 0) AS DECIMAL(18,4)) AS quantity,
        CAST(ISNULL(l.QTY_SHIPPED, 0) AS DECIMAL(18,4)) AS shipped_quantity,
        RTRIM(LTRIM(CONVERT(NVARCHAR(16), ISNULL(l.LIN_TYP, N'')))) AS line_type,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.ITEM_NO, N'')))) AS item_no,
        RTRIM(LTRIM(CONVERT(NVARCHAR(128), ISNULL(l.BARCOD, N'')))) AS barcode,
        CAST(l.REG_PRC AS DECIMAL(18,4)) AS regular_price,
        CAST(l.PRC AS DECIMAL(18,4)) AS price,
        CAST(l.CALC_PRC AS DECIMAL(18,4)) AS calculated_price,
        CAST(l.EXT_PRC AS DECIMAL(18,4)) AS extended_price,
        CAST(l.GROSS_EXT_PRC AS DECIMAL(18,4)) AS gross_extended_price,
        CAST(l.DISP_EXT_PRC AS DECIMAL(18,4)) AS display_extended_price,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.TAX_CATEG, N'')))) AS tax_category,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.NORM_TAX_CATEG, N'')))) AS normal_tax_category,
        CONVERT(NVARCHAR(36), l.LIN_GUID) AS line_guid,
        CAST(NULL AS NVARCHAR(36)) AS link_line_guid,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_1_UPR, N'')))) AS dim_1,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_2_UPR, N'')))) AS dim_2,
        RTRIM(LTRIM(CONVERT(NVARCHAR(80), ISNULL(l.DIM_3_UPR, N'')))) AS dim_3
      FROM PS_DOC_HDR h
      INNER JOIN PS_DOC_LIN l ON l.DOC_ID = h.DOC_ID
      OUTER APPLY (
        SELECT TOP 1 SUB_TOT, TAX_AMT, TOT, TOT_TND
        FROM PS_DOC_HDR_TOT source_total
        WHERE source_total.DOC_ID = h.DOC_ID
        ORDER BY CASE WHEN source_total.TOT_TYP = 'O' THEN 0 ELSE 1 END,
                 source_total.TOT_TYP
      ) t
      WHERE h.DOC_ID IN (${values})
      ORDER BY h.DOC_ID, l.LIN_SEQ_NO
    `);
    rows.push(...(result.recordset ?? []));
  }
  return rows;
}

function historyComponentsByTicket(rows, taxByDoc) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${clean(row.doc_id)}|${clean(row.ticket_no)}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const result = [];
  for (const ticketRows of grouped.values()) {
    const saleRows = ticketRows.filter(
      (row) => clean(row.line_type).toUpperCase() === "S",
    );
    const components = saleRows.map((row) => sourceLine(row));
    allocateTax(
      components,
      ticketRows[0]?.header_tax,
      taxByDoc.get(clean(ticketRows[0]?.doc_id)),
    );
    result.push(...components);
  }
  return result;
}

function buildCurrentOrderSource(openRows, historyRows, taxByDoc) {
  const historyComponents = historyComponentsByTicket(
    historyRows,
    taxByDoc,
  );
  const completedByLink = new Map();
  for (const component of historyComponents) {
    if (!component.linkGuid) continue;
    const group = completedByLink.get(component.linkGuid) ?? [];
    group.push(component);
    completedByLink.set(component.linkGuid, group);
  }
  const openComponents = openRows
    .filter((row) => number(row.quantity) > 0)
    .map((row) => sourceLine(row));
  allocateTax(
    openComponents,
    openRows[0]?.header_tax,
    taxByDoc.get(clean(openRows[0]?.doc_id)),
  );
  const openByGuid = new Map(
    openComponents.map((component) => [component.lineGuid, component]),
  );
  const sourceLines = [];
  for (const row of openRows) {
    const lineGuid = clean(row.line_guid);
    const openComponent = openByGuid.get(lineGuid);
    const completed = completedByLink.get(lineGuid) ?? [];
    const openQuantity = Math.max(0, number(row.quantity));
    const shippedQuantity = Math.max(0, number(row.shipped_quantity));
    const completedQuantity = completed.reduce(
      (sum, component) => sum + Math.max(0, component.quantity),
      0,
    );
    if (completedQuantity !== shippedQuantity) {
      throw new Error(
        `shipped quantity ${shippedQuantity} does not match sale history ${completedQuantity}`,
      );
    }
    const components = [
      ...(openComponent ? [openComponent] : []),
      ...completed,
    ];
    const quantity = components.reduce(
      (sum, component) => sum + Math.max(0, component.quantity),
      0,
    );
    if (quantity <= 0) throw new Error("order line has no open or sold quantity");
    const prices = new Set(components.map((component) => component.unit));
    if (prices.size !== 1) throw new Error("order line has mixed charged prices");
    const stateExtended = components.reduce(
      (sum, component) => sum + component.quantity * component.stateTax,
      0,
    );
    const localExtended = components.reduce(
      (sum, component) => sum + component.quantity * component.localTax,
      0,
    );
    const template = openComponent ?? completed[0];
    sourceLines.push({
      ...template,
      sequence: Number(row.line_sequence ?? template.sequence),
      quantity,
      original: Math.max(...components.map((component) => component.original)),
      discount:
        Math.max(...components.map((component) => component.original)) -
        template.unit,
      stateTax: Math.round(stateExtended / quantity),
      localTax: Math.round(localExtended / quantity),
      evidence: {
        source: "current_open_document_lifecycle",
        counterpoint_doc_id: clean(row.doc_id),
        counterpoint_order_no: clean(row.ticket_no),
        counterpoint_open_line_guid: lineGuid,
        open_quantity: openQuantity,
        shipped_quantity: shippedQuantity,
        completed_sales: completed.map((component) => component.evidence),
      },
    });
  }
  const completedTicketTotals = new Map();
  for (const row of historyRows) {
    if (clean(row.line_type).toUpperCase() !== "S") continue;
    completedTicketTotals.set(
      `${clean(row.doc_id)}|${clean(row.ticket_no)}`,
      cents(row.header_total) ?? 0,
    );
  }
  const total =
    (cents(openRows[0]?.header_total) ?? 0) +
    [...completedTicketTotals.values()].reduce((sum, value) => sum + value, 0);
  return { sourceLines, total };
}

function buildClosedOrderSource(historyRows, taxByDoc) {
  if (
    historyRows.some((row) => clean(row.line_type).toUpperCase() === "R")
  ) {
    throw new Error("closed order history contains a return line");
  }
  const components = historyComponentsByTicket(historyRows, taxByDoc);
  const byLink = new Map();
  for (const component of components) {
    const key = component.linkGuid || component.key;
    const group = byLink.get(key) ?? [];
    group.push(component);
    byLink.set(key, group);
  }
  const sourceLines = [];
  for (const [linkGuid, group] of byLink.entries()) {
    const prices = new Set(group.map((component) => component.unit));
    if (prices.size !== 1) throw new Error("closed order line has mixed charged prices");
    const quantity = group.reduce(
      (sum, component) => sum + Math.max(0, component.quantity),
      0,
    );
    if (quantity <= 0) continue;
    const template = group[0];
    const original = Math.max(...group.map((component) => component.original));
    sourceLines.push({
      ...template,
      quantity,
      original,
      discount: original - template.unit,
      stateTax: Math.round(
        group.reduce(
          (sum, component) => sum + component.quantity * component.stateTax,
          0,
        ) / quantity,
      ),
      localTax: Math.round(
        group.reduce(
          (sum, component) => sum + component.quantity * component.localTax,
          0,
        ) / quantity,
      ),
      evidence: {
        source: "closed_order_ticket_lifecycle",
        counterpoint_order_line_guid: linkGuid,
        completed_sales: group.map((component) => component.evidence),
      },
    });
  }
  const ticketTotals = new Map();
  for (const row of historyRows) {
    if (clean(row.line_type).toUpperCase() !== "S") continue;
    ticketTotals.set(
      `${clean(row.doc_id)}|${clean(row.ticket_no)}`,
      cents(row.header_total) ?? 0,
    );
  }
  return {
    sourceLines,
    total: [...ticketTotals.values()].reduce((sum, value) => sum + value, 0),
  };
}

function matchLines(rosLines, sourceLines) {
  if (rosLines.length !== sourceLines.length) {
    throw new Error(
      `ROS/source line count differs (${rosLines.length}/${sourceLines.length})`,
    );
  }
  const used = new Set();
  const result = [];
  for (const rosLine of rosLines) {
    const rosKey =
      clean(rosLine.counterpoint_item_key) ||
      clean(rosLine.size_specs?.counterpoint_item_key);
    const rosSequence = Number(
      rosLine.size_specs?.counterpoint_line_sequence ?? 0,
    );
    const rosQuantity = number(rosLine.quantity);
    const candidates = sourceLines
      .map((sourceLine, index) => ({ sourceLine, index }))
      .filter(({ index }) => !used.has(index))
      .map(({ sourceLine, index }) => {
        let score = 0;
        if (rosKey && sourceLine.key === rosKey) score += 100;
        if (
          sourceLine.sku &&
          [rosLine.sku, rosLine.barcode, rosLine.size_specs?.counterpoint_sku]
            .map(normalized)
            .includes(normalized(sourceLine.sku))
        ) {
          score += 80;
        }
        if (rosSequence && sourceLine.sequence === rosSequence) score += 120;
        if (sourceLine.quantity === rosQuantity) score += 20;
        return { sourceLine, index, score };
      })
      .sort((left, right) => right.score - left.score);
    if (!candidates[0] || candidates[0].score < 100) {
      throw new Error(`could not exactly match ROS line ${rosLine.line_id}`);
    }
    used.add(candidates[0].index);
    result.push([rosLine, candidates[0].sourceLine]);
  }
  return result;
}

function buildCandidate(transaction, source, sourceKind, mapped) {
  const lineRepairs = [];
  let projectedLineTotal = 0;
  for (const [rosLine, sourceLineValue] of mapped) {
    if (number(rosLine.quantity) !== sourceLineValue.quantity) {
      throw new Error("source quantity differs from the preserved ROS quantity");
    }
    projectedLineTotal +=
      sourceLineValue.quantity *
      (sourceLineValue.unit +
        sourceLineValue.stateTax +
        sourceLineValue.localTax);
    const expected = {
      unit: cents(rosLine.unit_price) ?? 0,
      discount: cents(rosLine.discount_amount) ?? 0,
      state: cents(rosLine.state_tax) ?? 0,
      local: cents(rosLine.local_tax) ?? 0,
    };
    if (
      expected.unit === sourceLineValue.unit &&
      expected.discount === sourceLineValue.discount &&
      expected.state + expected.local ===
        sourceLineValue.stateTax + sourceLineValue.localTax
    ) {
      continue;
    }
    lineRepairs.push({
      line_id: rosLine.line_id,
      expected_quantity: number(rosLine.quantity),
      expected_unit_price: money(expected.unit),
      expected_discount_amount: money(expected.discount),
      expected_state_tax: money(expected.state),
      expected_local_tax: money(expected.local),
      corrected_unit_price: money(sourceLineValue.unit),
      corrected_discount_amount: money(sourceLineValue.discount),
      corrected_state_tax: money(sourceLineValue.stateTax),
      corrected_local_tax: money(sourceLineValue.localTax),
      source_evidence: sourceLineValue.evidence,
    });
  }
  const shipping = cents(transaction.shipping_amount_usd) ?? 0;
  const expectedTotal = cents(transaction.total_price) ?? 0;
  const expectedPaid = cents(transaction.amount_paid) ?? 0;
  const expectedBalance = cents(transaction.balance_due) ?? 0;
  const correctedBalance = Math.max(0, source.total - expectedPaid);
  if (
    lineRepairs.length === 0 &&
    expectedTotal === source.total &&
    expectedBalance === correctedBalance
  ) {
    return null;
  }
  if (projectedLineTotal + shipping !== source.total) {
    throw new Error(
      `source lines plus shipping ${money(projectedLineTotal + shipping)} do not equal source lifecycle total ${money(source.total)}`,
    );
  }
  return {
    manifest_key: `2026-07-24-counterpoint-tax-authority-paid-price-v2:${transaction.transaction_id}`,
    transaction_id: transaction.transaction_id,
    display_id: transaction.display_id,
    source_doc_id: transaction.docId,
    expected_total: money(expectedTotal),
    expected_amount_paid: money(expectedPaid),
    expected_balance: money(expectedBalance),
    corrected_total: money(source.total),
    corrected_balance: money(correctedBalance),
    line_repairs: lineRepairs,
    source_kind: sourceKind,
  };
}

function groupTransactions(rows) {
  const transactions = new Map();
  for (const row of rows) {
    const transaction = transactions.get(row.transaction_id) ?? {
      ...row,
      rows: [],
      ...parseReference(row.counterpoint_doc_ref || row.counterpoint_ticket_ref),
      orderBase: orderBase(row.counterpoint_doc_ref),
    };
    transaction.rows.push(row);
    transactions.set(row.transaction_id, transaction);
  }
  return [...transactions.values()];
}

function buildReturnReviewBlocks(entries, transactions) {
  const transactionsById = new Map(
    transactions.map((transaction) => [
      transaction.transaction_id,
      transaction,
    ]),
  );
  const reasonsByTransaction = new Map();
  for (const entry of entries) {
    const current = reasonsByTransaction.get(entry.transaction_id) ?? {
      sourceKind: entry.source_kind,
      reasons: new Set(),
    };
    for (const reason of entry.reasons ?? []) {
      const normalizedReason = clean(reason);
      if (normalizedReason) current.reasons.add(normalizedReason);
    }
    reasonsByTransaction.set(entry.transaction_id, current);
  }

  const blocks = [];
  for (const [transactionId, review] of reasonsByTransaction.entries()) {
    const transaction = transactionsById.get(transactionId);
    if (!transaction || review.reasons.size === 0) continue;
    const lineSnapshot = transaction.rows
      .map((line) => ({
        line_id: line.line_id,
        quantity: number(line.quantity),
        unit_price: money(cents(line.unit_price) ?? 0),
        discount_amount: money(cents(line.discount_amount) ?? 0),
        state_tax: money(cents(line.state_tax) ?? 0),
        local_tax: money(cents(line.local_tax) ?? 0),
      }))
      .sort((left, right) => left.line_id.localeCompare(right.line_id));
    blocks.push({
      manifest_key: `2026-07-24-counterpoint-return-review-v1:${transactionId}`,
      transaction_id: transactionId,
      display_id: transaction.display_id,
      source_kind: review.sourceKind,
      reasons: [...review.reasons].sort(),
      expected_counterpoint_ticket_ref:
        transaction.counterpoint_ticket_ref ?? null,
      expected_counterpoint_doc_ref:
        transaction.counterpoint_doc_ref ?? null,
      expected_total: money(cents(transaction.total_price) ?? 0),
      expected_amount_paid: money(cents(transaction.amount_paid) ?? 0),
      expected_balance: money(cents(transaction.balance_due) ?? 0),
      expected_allocated_tender_total: money(
        cents(transaction.allocated_tender_total) ?? 0,
      ),
      line_snapshot: lineSnapshot,
    });
  }
  return blocks.sort((left, right) =>
    left.display_id.localeCompare(right.display_id),
  );
}

function blockedDetails(transaction, source, candidate, mapped) {
  if (!includeBlockedDetails) return {};
  return {
    details: {
      status: transaction.status,
      total_price: transaction.total_price,
      amount_paid: transaction.amount_paid,
      balance_due: transaction.balance_due,
      allocated_tender_total: transaction.allocated_tender_total,
      positive_tender_total: transaction.positive_tender_total,
      refunded_tender_total: transaction.refunded_tender_total,
      return_event_count: transaction.return_event_count,
      refund_allocation_count: transaction.refund_allocation_count,
      ros_lines: transaction.rows.map((line) => ({
        line_id: line.line_id,
        quantity: number(line.quantity),
        counterpoint_item_key:
          clean(line.counterpoint_item_key) ||
          clean(line.size_specs?.counterpoint_item_key),
        unit_price: line.unit_price,
        discount_amount: line.discount_amount,
        state_tax: line.state_tax,
        local_tax: line.local_tax,
      })),
      source_total: source ? money(source.total) : null,
      source_lines:
        source?.sourceLines.map((line) => ({
          quantity: line.quantity,
          counterpoint_item_key: line.key,
          unit_price: money(line.unit),
          discount_amount: money(line.discount),
          state_tax: money(line.stateTax),
          local_tax: money(line.localTax),
          evidence: line.evidence,
        })) ?? [],
      mapped_lines:
        mapped?.map(([rosLine, sourceLineValue]) => ({
          line_id: rosLine.line_id,
          ros_quantity: number(rosLine.quantity),
          source_quantity: sourceLineValue.quantity,
          counterpoint_item_key: sourceLineValue.key,
          source_unit_price: money(sourceLineValue.unit),
          source_discount_amount: money(sourceLineValue.discount),
          source_state_tax: money(sourceLineValue.stateTax),
          source_local_tax: money(sourceLineValue.localTax),
          source_evidence: sourceLineValue.evidence,
        })) ?? [],
      candidate: candidate ?? null,
    },
  };
}

function transactionSafetyBlockers(transaction, source, sourceKind) {
  const blockers = [];
  if (number(transaction.return_event_count) !== 0) {
    blockers.push("existing return history");
  }
  if (number(transaction.refund_allocation_count) !== 0) {
    blockers.push("existing refund allocation");
  }
  const allocatedTender = cents(transaction.allocated_tender_total) ?? 0;
  const storedPaid = cents(transaction.amount_paid) ?? 0;
  const sourceVerifiedLegacyPaid =
    sourceKind === "completed_sale_ticket" &&
    allocatedTender === 0 &&
    (cents(transaction.total_price) ?? 0) === source.total &&
    storedPaid === source.total &&
    (cents(transaction.balance_due) ?? 0) === 0;
  if (allocatedTender !== storedPaid && !sourceVerifiedLegacyPaid) {
    blockers.push("stored paid amount differs from payment allocations");
  }
  if (sourceKind === "completed_sale_ticket" && storedPaid < source.total) {
    blockers.push("stored completed-ticket paid amount is below source total");
  }
  return blockers;
}

function buildHistoricalRefundCandidate(
  transaction,
  source,
  sourceKind,
  mapped,
  safetyBlockers,
) {
  if (
    sourceKind !== "closed_order_lifecycle" ||
    number(transaction.return_event_count) !== 0 ||
    (cents(transaction.shipping_amount_usd) ?? 0) !== 0 ||
    mapped.length !== transaction.rows.length
  ) {
    return null;
  }

  const sourceTotal = source.total;
  const storedPaid = cents(transaction.amount_paid) ?? 0;
  const positiveTender = cents(transaction.positive_tender_total) ?? 0;
  const refundedTender = cents(transaction.refunded_tender_total) ?? 0;
  const netTender = cents(transaction.allocated_tender_total) ?? 0;
  const hasHistoricalRefund = refundedTender > 0;
  const sourceTicketTimes = mapped
    .flatMap(([, sourceLineValue]) => {
      const evidence = sourceLineValue.evidence ?? {};
      const completedSales = Array.isArray(evidence.completed_sales)
        ? evidence.completed_sales
        : [];
      return [
        evidence.counterpoint_ticket_at,
        ...completedSales.map((sale) => sale.counterpoint_ticket_at),
      ].filter(Boolean);
    })
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()));
  if (sourceTicketTimes.length === 0) return null;
  const sourceFulfilledAt = new Date(
    Math.max(...sourceTicketTimes.map((value) => value.getTime())),
  ).toISOString();
  let sourceLineTotal = 0;
  let reconstructedRefundTotal = 0;
  let hasQuantityChange = false;
  const lineRepairs = [];
  for (const [rosLine, sourceLineValue] of mapped) {
    const expectedQuantity = number(rosLine.quantity);
    const correctedQuantity = number(sourceLineValue.quantity);
    if (
      !Number.isInteger(correctedQuantity) ||
      correctedQuantity <= 0 ||
      correctedQuantity < expectedQuantity
    ) {
      return null;
    }
    const quantityDifference = correctedQuantity - expectedQuantity;
    const returnedQuantity = hasHistoricalRefund ? quantityDifference : 0;
    hasQuantityChange ||= quantityDifference > 0;
    const sourceUnitTotal =
      sourceLineValue.unit +
      sourceLineValue.stateTax +
      sourceLineValue.localTax;
    sourceLineTotal += correctedQuantity * sourceUnitTotal;
    reconstructedRefundTotal += returnedQuantity * sourceUnitTotal;
    lineRepairs.push({
      line_id: rosLine.line_id,
      expected_quantity: expectedQuantity,
      expected_unit_price: money(cents(rosLine.unit_price) ?? 0),
      expected_discount_amount: money(cents(rosLine.discount_amount) ?? 0),
      expected_state_tax: money(cents(rosLine.state_tax) ?? 0),
      expected_local_tax: money(cents(rosLine.local_tax) ?? 0),
      corrected_quantity: correctedQuantity,
      corrected_unit_price: money(sourceLineValue.unit),
      corrected_discount_amount: money(sourceLineValue.discount),
      corrected_state_tax: money(sourceLineValue.stateTax),
      corrected_local_tax: money(sourceLineValue.localTax),
      returned_quantity: returnedQuantity,
      refund_subtotal: money(returnedQuantity * sourceLineValue.unit),
      refund_state_tax: money(returnedQuantity * sourceLineValue.stateTax),
      refund_local_tax: money(returnedQuantity * sourceLineValue.localTax),
      refund_total: money(returnedQuantity * sourceUnitTotal),
      source_evidence: sourceLineValue.evidence,
    });
  }
  if (!hasQuantityChange || sourceLineTotal !== source.total) return null;

  const refundIsExact =
    refundedTender > 0 &&
    refundedTender === reconstructedRefundTotal &&
    sourceTotal - refundedTender === storedPaid &&
    safetyBlockers.length === 1 &&
    safetyBlockers[0] === "existing refund allocation";
  const noRefundIsExact =
    refundedTender === 0 &&
    storedPaid === sourceTotal &&
    netTender === sourceTotal &&
    safetyBlockers.length === 0;
  if (
    positiveTender !== sourceTotal ||
    netTender !== storedPaid ||
    storedPaid < 0 ||
    (!refundIsExact && !noRefundIsExact)
  ) {
    return null;
  }

  return {
    manifest_key: `2026-07-24-counterpoint-historical-refund:${transaction.transaction_id}`,
    transaction_id: transaction.transaction_id,
    display_id: transaction.display_id,
    source_doc_id: transaction.docId,
    expected_status: transaction.status,
    expected_total: money(cents(transaction.total_price) ?? 0),
    expected_amount_paid: money(storedPaid),
    expected_balance: money(cents(transaction.balance_due) ?? 0),
    expected_positive_tender_total: money(positiveTender),
    expected_refunded_tender_total: money(refundedTender),
    expected_net_tender_total: money(netTender),
    source_total: money(sourceTotal),
    source_fulfilled_at: sourceFulfilledAt,
    corrected_total: money(sourceTotal - refundedTender),
    corrected_balance: "0.00",
    line_repairs: lineRepairs,
    source_kind: sourceKind,
  };
}

function verifyHistoricalRefundRestoration(
  transaction,
  source,
  sourceKind,
  mapped,
) {
  const reasons = [];
  if (
    sourceKind !== "closed_order_lifecycle" ||
    number(transaction.historical_restoration_count) !== 1 ||
    transaction.has_historical_restoration_marker !== true
  ) {
    reasons.push("historical restoration audit evidence is incomplete");
  }

  let sourceLineTotal = 0;
  let restoredRefundTotal = 0;
  let restoredReturnRows = 0;
  for (const [rosLine, sourceLineValue] of mapped) {
    const returnedQuantity = number(rosLine.returned_quantity);
    if (
      number(rosLine.quantity) !== sourceLineValue.quantity ||
      returnedQuantity < 0 ||
      returnedQuantity > sourceLineValue.quantity
    ) {
      reasons.push("restored source and returned quantities do not reconcile");
      continue;
    }
    if (
      (cents(rosLine.unit_price) ?? 0) !== sourceLineValue.unit ||
      (cents(rosLine.discount_amount) ?? 0) !== sourceLineValue.discount ||
      (cents(rosLine.state_tax) ?? 0) +
          (cents(rosLine.local_tax) ?? 0) !==
        sourceLineValue.stateTax + sourceLineValue.localTax
    ) {
      reasons.push("restored line paid price differs from Counterpoint");
    }
    const sourceUnitTotal =
      sourceLineValue.unit +
      sourceLineValue.stateTax +
      sourceLineValue.localTax;
    sourceLineTotal += sourceLineValue.quantity * sourceUnitTotal;
    if (returnedQuantity > 0) {
      restoredReturnRows += 1;
      const expectedRefundSubtotal = returnedQuantity * sourceLineValue.unit;
      const expectedRefundStateTax =
        returnedQuantity * sourceLineValue.stateTax;
      const expectedRefundLocalTax =
        returnedQuantity * sourceLineValue.localTax;
      const expectedRefundTotal = returnedQuantity * sourceUnitTotal;
      if (
        (cents(rosLine.returned_refund_subtotal) ?? 0) !==
          expectedRefundSubtotal ||
        (cents(rosLine.returned_refund_state_tax) ?? 0) +
            (cents(rosLine.returned_refund_local_tax) ?? 0) !==
          expectedRefundStateTax + expectedRefundLocalTax ||
        (cents(rosLine.returned_refund_total) ?? 0) !== expectedRefundTotal
      ) {
        reasons.push(
          "restored historical return amount differs from the Counterpoint paid price",
        );
      }
      restoredRefundTotal += expectedRefundTotal;
    }
  }

  const expectedEffectiveTotal = source.total - restoredRefundTotal;
  if (
    sourceLineTotal !== source.total ||
    restoredReturnRows !== number(transaction.return_event_count) ||
    restoredRefundTotal !==
      (cents(transaction.refunded_tender_total) ?? 0) ||
    source.total !== (cents(transaction.positive_tender_total) ?? 0) ||
    expectedEffectiveTotal !==
      (cents(transaction.allocated_tender_total) ?? 0) ||
    expectedEffectiveTotal !== (cents(transaction.total_price) ?? 0) ||
    expectedEffectiveTotal !== (cents(transaction.amount_paid) ?? 0) ||
    (cents(transaction.balance_due) ?? 0) !== 0 ||
    transaction.status !== "fulfilled"
  ) {
    reasons.push(
      "restored gross sale, historical refund, effective total, paid amount, or balance does not reconcile",
    );
  }
  return [...new Set(reasons)];
}

async function main() {
  if (!outputPath) {
    throw new Error("--output <path> is required");
  }
  const rosRows = pgJsonRows(`
    WITH return_rollup AS (
      SELECT transaction_id, COUNT(*)::bigint AS return_event_count
      FROM transaction_return_lines
      GROUP BY transaction_id
    ),
    line_return_rollup AS (
      SELECT
        transaction_line_id,
        SUM(quantity_returned)::bigint AS returned_quantity,
        ROUND(COALESCE(SUM(refund_subtotal), 0), 2)::numeric(14,2)
          AS returned_refund_subtotal,
        ROUND(COALESCE(SUM(refund_state_tax), 0), 2)::numeric(14,2)
          AS returned_refund_state_tax,
        ROUND(COALESCE(SUM(refund_local_tax), 0), 2)::numeric(14,2)
          AS returned_refund_local_tax,
        ROUND(COALESCE(SUM(refund_total), 0), 2)::numeric(14,2)
          AS returned_refund_total
      FROM transaction_return_lines
      GROUP BY transaction_line_id
    ),
    historical_restoration AS (
      SELECT transaction_id, COUNT(*)::bigint AS restoration_count
      FROM transaction_activity_log
      WHERE event_kind = 'counterpoint_historical_refund_restoration'
      GROUP BY transaction_id
    ),
    allocation_rollup AS (
      SELECT
        pa.target_transaction_id AS transaction_id,
        COUNT(*) FILTER (
          WHERE pa.amount_allocated < 0
             OR COALESCE(pa.metadata->>'kind', '') IN (
               'order_refund', 'exchange_refund_remainder'
             )
        )::bigint AS refund_allocation_count,
        ROUND(COALESCE(SUM(pa.amount_allocated), 0), 2)::numeric(14,2)
          AS allocated_tender_total,
        ROUND(
          COALESCE(SUM(GREATEST(pa.amount_allocated, 0)), 0),
          2
        )::numeric(14,2) AS positive_tender_total,
        ROUND(
          COALESCE(SUM(GREATEST(-pa.amount_allocated, 0)), 0),
          2
        )::numeric(14,2) AS refunded_tender_total
      FROM payment_allocations pa
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
      t.shipping_amount_usd::text,
      COALESCE(rr.return_event_count, 0)::bigint AS return_event_count,
      COALESCE(hr.restoration_count, 0)::bigint AS historical_restoration_count,
      (COALESCE(t.metadata, '{}'::jsonb)
        ? 'counterpoint_historical_refund_restoration')
        AS has_historical_restoration_marker,
      COALESCE(ar.refund_allocation_count, 0)::bigint AS refund_allocation_count,
      COALESCE(ar.allocated_tender_total, 0)::text AS allocated_tender_total,
      COALESCE(ar.positive_tender_total, 0)::text AS positive_tender_total,
      COALESCE(ar.refunded_tender_total, 0)::text AS refunded_tender_total,
      tl.id::text AS line_id,
      tl.quantity,
      tl.unit_price::text,
      tl.discount_amount::text,
      tl.state_tax::text,
      tl.local_tax::text,
      COALESCE(lrr.returned_quantity, 0)::bigint AS returned_quantity,
      COALESCE(lrr.returned_refund_subtotal, 0)::text
        AS returned_refund_subtotal,
      COALESCE(lrr.returned_refund_state_tax, 0)::text
        AS returned_refund_state_tax,
      COALESCE(lrr.returned_refund_local_tax, 0)::text
        AS returned_refund_local_tax,
      COALESCE(lrr.returned_refund_total, 0)::text AS returned_refund_total,
      pv.counterpoint_item_key,
      pv.sku,
      pv.barcode,
      COALESCE(tl.size_specs, '{}'::jsonb) AS size_specs
    FROM transactions t
    INNER JOIN transaction_lines tl ON tl.transaction_id = t.id
    INNER JOIN product_variants pv ON pv.id = tl.variant_id
    LEFT JOIN return_rollup rr ON rr.transaction_id = t.id
    LEFT JOIN line_return_rollup lrr ON lrr.transaction_line_id = tl.id
    LEFT JOIN historical_restoration hr ON hr.transaction_id = t.id
    LEFT JOIN allocation_rollup ar ON ar.transaction_id = t.id
    WHERE COALESCE(t.is_counterpoint_import, FALSE)
      AND (t.counterpoint_ticket_ref IS NOT NULL OR t.counterpoint_doc_ref IS NOT NULL)
      AND COALESCE(t.metadata->>'counterpoint_reconciliation_status', '') <> 'superseded'
    ORDER BY t.id, tl.line_display_id NULLS LAST, tl.id
  `);
  const transactions = groupTransactions(rosRows);
  const ticketDocIds = transactions
    .filter((transaction) => transaction.counterpoint_ticket_ref)
    .map((transaction) => transaction.docId)
    .filter(Boolean);
  const orderDocIds = transactions
    .filter((transaction) => transaction.counterpoint_doc_ref)
    .map((transaction) => transaction.docId)
    .filter(Boolean);
  const orderBases = transactions
    .map((transaction) => transaction.orderBase)
    .filter(Boolean);

  const connectionString =
    process.env.COUNTERPOINT_SQL_CONNECTION_STRING?.trim() ||
    requiredEnv("SQL_CONNECTION_STRING");
  const pool = await counterpointPool(connectionString).connect();
  try {
    const historyRows = await fetchTicketHistory(
      pool,
      ticketDocIds,
      orderBases,
    );
    const openRows = await fetchOpenDocuments(pool, orderDocIds);
    const [historyTaxRows, openTaxRows] = await Promise.all([
      fetchDocumentTaxRows(
        pool,
        "PS_TKT_HIST_TAX",
        historyRows.map((row) => clean(row.doc_id)).filter(Boolean),
      ),
      fetchDocumentTaxRows(
        pool,
        "PS_DOC_TAX",
        openRows.map((row) => clean(row.doc_id)).filter(Boolean),
      ),
    ]);
    const taxByDoc = taxRowsByDocument([
      ...historyTaxRows,
      ...openTaxRows,
    ]);
    const historyByDoc = new Map();
    const historyByOrder = new Map();
    for (const row of historyRows) {
      const byDoc = historyByDoc.get(clean(row.doc_id)) ?? [];
      byDoc.push(row);
      historyByDoc.set(clean(row.doc_id), byDoc);
      const base = orderBase(row.ticket_no);
      if (base) {
        const byOrder = historyByOrder.get(base) ?? [];
        byOrder.push(row);
        historyByOrder.set(base, byOrder);
      }
    }
    const openByDoc = new Map();
    for (const row of openRows) {
      const group = openByDoc.get(clean(row.doc_id)) ?? [];
      group.push(row);
      openByDoc.set(clean(row.doc_id), group);
    }

    const candidates = [];
    const blocked = [];
    const financialObservations = [];
    const lifecycleRepairCandidates = [];
    const verifiedHistoricalRestorations = [];
    for (const transaction of transactions) {
      let sourceKind = "";
      let relevant = false;
      let source;
      let candidate;
      let mapped;
      let safetyBlockers = [];
      try {
        if (transaction.counterpoint_doc_ref) {
          relevant = true;
          sourceKind = openByDoc.has(transaction.docId)
            ? "current_open_order_lifecycle"
            : "closed_order_lifecycle";
          const orderHistory = historyByOrder.get(transaction.orderBase) ?? [];
          source = openByDoc.has(transaction.docId)
            ? buildCurrentOrderSource(
                openByDoc.get(transaction.docId),
                orderHistory,
                taxByDoc,
              )
            : buildClosedOrderSource(orderHistory, taxByDoc);
        } else {
          const sourceRows = (historyByDoc.get(transaction.docId) ?? []).filter(
            (row) => clean(row.ticket_no) === transaction.ticketNo,
          );
          const lineTypes = new Set(
            sourceRows.map((row) => clean(row.line_type).toUpperCase()),
          );
          if (lineTypes.size !== 1 || !lineTypes.has("S")) continue;
          relevant = true;
          sourceKind = "completed_sale_ticket";
          const sourceLines = sourceRows.map((row) => sourceLine(row));
          allocateTax(
            sourceLines,
            sourceRows[0]?.header_tax,
            taxByDoc.get(clean(sourceRows[0]?.doc_id)),
          );
          source = {
            sourceLines,
            total: cents(sourceRows[0]?.header_total) ?? 0,
          };
        }

        if (number(transaction.historical_restoration_count) > 0) {
          mapped = matchLines(transaction.rows, source.sourceLines);
          const restorationReasons = verifyHistoricalRefundRestoration(
            transaction,
            source,
            sourceKind,
            mapped,
          );
          if (restorationReasons.length > 0) {
            blocked.push({
              transaction_id: transaction.transaction_id,
              display_id: transaction.display_id,
              source_kind: sourceKind,
              reasons: restorationReasons,
              ...blockedDetails(transaction, source, candidate, mapped),
            });
          } else {
            verifiedHistoricalRestorations.push({
              transaction_id: transaction.transaction_id,
              display_id: transaction.display_id,
              source_kind: sourceKind,
              source_total: money(source.total),
              historical_refund_total: money(
                cents(transaction.refunded_tender_total) ?? 0,
              ),
              effective_total: money(cents(transaction.total_price) ?? 0),
              amount_paid: money(cents(transaction.amount_paid) ?? 0),
              balance: money(cents(transaction.balance_due) ?? 0),
            });
          }
          continue;
        }

        safetyBlockers = transactionSafetyBlockers(
          transaction,
          source,
          sourceKind,
        );
        mapped = matchLines(transaction.rows, source.sourceLines);
        const lifecycleRepairCandidate = buildHistoricalRefundCandidate(
          transaction,
          source,
          sourceKind,
          mapped,
          safetyBlockers,
        );
        if (lifecycleRepairCandidate) {
          lifecycleRepairCandidates.push(lifecycleRepairCandidate);
          continue;
        }
        candidate = buildCandidate(transaction, source, sourceKind, mapped);
        if (!candidate) {
          if (safetyBlockers.length > 0) {
            financialObservations.push({
              transaction_id: transaction.transaction_id,
              display_id: transaction.display_id,
              source_kind: sourceKind,
              reasons: safetyBlockers,
              ...blockedDetails(transaction, source, candidate, mapped),
            });
          }
          continue;
        }
        if (safetyBlockers.length > 0) {
          blocked.push({
            transaction_id: transaction.transaction_id,
            display_id: transaction.display_id,
            source_kind: sourceKind,
            reasons: safetyBlockers,
            ...blockedDetails(transaction, source, candidate, mapped),
          });
        } else if (candidate) {
          candidates.push(candidate);
        }
      } catch (error) {
        if (relevant) {
          blocked.push({
            transaction_id: transaction.transaction_id,
            display_id: transaction.display_id,
            source_kind: sourceKind,
            reasons: [...new Set([error.message, ...safetyBlockers])],
            ...blockedDetails(transaction, source, candidate, mapped),
          });
        }
      }
    }
    candidates.sort((left, right) =>
      left.display_id.localeCompare(right.display_id),
    );
    blocked.sort((left, right) =>
      left.display_id.localeCompare(right.display_id),
    );
    lifecycleRepairCandidates.sort((left, right) =>
      left.display_id.localeCompare(right.display_id),
    );
    verifiedHistoricalRestorations.sort((left, right) =>
      left.display_id.localeCompare(right.display_id),
    );
    const manifestDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(candidates))
      .digest("hex");
    const lifecycleManifestDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(lifecycleRepairCandidates))
      .digest("hex");
    const returnReviewBlocks = buildReturnReviewBlocks(
      [...blocked, ...financialObservations],
      transactions,
    );
    const returnReviewBlockManifestDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(returnReviewBlocks))
      .digest("hex");
    const output = {
      version: 2,
      generated_at: new Date().toISOString(),
      mode: "reviewed_counterpoint_paid_price_repair",
      source_manifest_digest: manifestDigest,
      scope: {
        imported_transactions_scanned: transactions.length,
        candidate_transactions: candidates.length,
        candidate_lines: candidates.reduce(
          (sum, candidate) => sum + candidate.line_repairs.length,
          0,
        ),
        blocked_transactions: blocked.length,
        financial_observation_transactions: financialObservations.length,
        lifecycle_repair_transactions: lifecycleRepairCandidates.length,
        lifecycle_repair_lines: lifecycleRepairCandidates.reduce(
          (sum, candidate) => sum + candidate.line_repairs.length,
          0,
        ),
        verified_historical_restorations:
          verifiedHistoricalRestorations.length,
        return_review_block_transactions: returnReviewBlocks.length,
        candidates_by_source_kind: candidates.reduce((counts, candidate) => {
          counts[candidate.source_kind] =
            (counts[candidate.source_kind] ?? 0) + 1;
          return counts;
        }, {}),
      },
      candidates,
      lifecycle_repair_manifest_digest: lifecycleManifestDigest,
      lifecycle_repair_candidates: lifecycleRepairCandidates,
      verified_historical_restorations: verifiedHistoricalRestorations,
      return_review_block_manifest_digest: returnReviewBlockManifestDigest,
      return_review_blocks: returnReviewBlocks,
      blocked,
      financial_observations: financialObservations,
    };
    fs.writeFileSync(
      path.resolve(outputPath),
      `${JSON.stringify(output, null, 2)}\n`,
    );
    console.log(
      JSON.stringify(
        {
          output: path.resolve(outputPath),
          source_manifest_digest: manifestDigest,
          lifecycle_repair_manifest_digest: lifecycleManifestDigest,
          return_review_block_manifest_digest:
            returnReviewBlockManifestDigest,
          scope: output.scope,
          blocked_by_reason: Object.entries(
            blocked
              .flatMap((entry) => entry.reasons)
              .reduce((counts, reason) => {
                counts[reason] = (counts[reason] ?? 0) + 1;
                return counts;
              }, {}),
          )
            .sort((left, right) => right[1] - left[1])
            .slice(0, 20),
          financial_observations_by_reason: Object.entries(
            financialObservations
              .flatMap((entry) => entry.reasons)
              .reduce((counts, reason) => {
                counts[reason] = (counts[reason] ?? 0) + 1;
                return counts;
              }, {}),
          )
            .sort((left, right) => right[1] - left[1])
            .slice(0, 20),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
