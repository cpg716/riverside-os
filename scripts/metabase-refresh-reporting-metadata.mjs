#!/usr/bin/env node

import fs from "node:fs";

const DEFAULT_METABASE_URL = "http://127.0.0.1:3001";

const STAFF_TABLE_LABELS = {
  alterations_active: "Active Alterations",
  appointments_no_show: "Appointments and No-Shows",
  customer_follow_up: "Customer Follow-Up",
  daily_order_totals: "Daily Sales Totals",
  exception_risk: "Exception and Risk",
  fulfillment_orders_core: "Fulfillment Orders",
  loyalty_customer_snapshot: "Loyalty Customer Snapshot",
  loyalty_point_ledger: "Loyalty Point Ledger",
  loyalty_reward_issuances: "Loyalty Reward Issuances",
  merchant_reconciliation: "Merchant Reconciliation",
  order_lines: "Transaction Lines",
  order_loyalty_accrual: "Loyalty Accrual",
  orders_core: "Transactions",
  payment_ledger: "Payment Ledger",
  register_day_activity: "Register Day Activity",
  shipments_active: "Active Shipments",
  staff_schedule_coverage_vs_sales: "Staff Coverage vs Sales",
  transaction_fulfillment_status: "Transaction Fulfillment Status",
  transactions_core: "Transactions",
  wedding_event_readiness: "Wedding Event Readiness",
  wedding_party_economics: "Wedding Party Economics",
};

const FIELD_MODEL = {
  order_lines: {
    show: {
      transaction_display_id: "Transaction #",
      order_short_id: "Order / Transaction #",
      fulfillment_order_display_id: "Fulfillment Order #",
      order_business_date: "Sale Date",
      order_recognition_business_date: "Fulfillment Date",
      order_status: "Status",
      item_display_name: "Item",
      product_display_name: "Product",
      variant_display_name: "Variant",
      sku: "SKU",
      barcode: "Barcode",
      category_name: "Category",
      vendor_display_name: "Vendor",
      customer_display_name: "Customer Name",
      customer_phone: "Customer Phone",
      customer_email: "Customer Email",
      line_salesperson_display_name: "Line Salesperson",
      primary_salesperson_display_name: "Primary Salesperson",
      operator_display_name: "Operator",
      quantity: "Quantity",
      unit_price: "Unit Price",
      line_extended_price: "Line Total",
      fulfillment: "Fulfillment Type",
      is_fulfilled: "Fulfilled",
      line_extended_cost: "Line Cost",
      line_gross_margin_pre_tax: "Gross Margin",
    },
    hide: [
      "line_id",
      "line_display_id",
      "transaction_id",
      "order_id",
      "product_id",
      "variant_id",
      "fulfillment_order_id",
      "customer_id",
    ],
  },
  payment_ledger: {
    show: {
      business_date: "Payment Date",
      category: "Category",
      status: "Status",
      payment_method: "Payment Method",
      check_number: "Check #",
      payment_provider: "Processor",
      gross_amount: "Gross Amount",
      merchant_fee: "Merchant Fee",
      net_amount: "Net Amount",
      payer_name: "Payer Name",
      payer_phone: "Payer Phone",
      payer_email: "Payer Email",
      primary_transaction_display_id: "Primary Transaction #",
      linked_transaction_display_ids: "Linked Transaction #s",
      linked_customer_names: "Linked Customers",
      card_brand: "Card Brand",
      card_last4: "Card Last 4",
    },
    hide: [
      "id",
      "payment_transaction_id",
      "payer_id",
      "linked_transaction_id",
      "provider_payment_id",
      "provider_transaction_id",
      "provider_auth_code",
      "provider_terminal_id",
      "provider_payment_id",
    ],
  },
};

const FIELD_LABELS = {
  appointment_count: "Appointments",
  appointment_date: "Appointment Date",
  appointment_type: "Appointment Type",
  avg_discount_percent: "Average Discount %",
  business_date: "Business Date",
  cashier_name: "Cashier",
  category_name: "Category",
  customer_display_name: "Customer",
  customer_email: "Customer Email",
  customer_name: "Customer",
  customer_phone: "Customer Phone",
  event_date: "Event Date",
  follow_up_reason: "Follow-Up Reason",
  fulfillment_order_display_id: "Fulfillment Order #",
  gross_amount: "Gross Amount",
  gross_margin: "Gross Margin",
  gross_revenue: "Gross Revenue",
  item_display_name: "Item",
  line_extended_cost: "Line Cost",
  line_extended_price: "Line Total",
  line_gross_margin_pre_tax: "Gross Margin",
  merchant_fee: "Merchant Fee",
  net_amount: "Net Amount",
  net_sales: "Net Sales",
  open_balance_total: "Open Balance Total",
  order_business_date: "Sale Date",
  order_count: "Transactions",
  order_recognition_business_date: "Fulfillment Date",
  payment_method: "Payment Method",
  primary_salesperson_display_name: "Primary Salesperson",
  product_display_name: "Product",
  product_name: "Product",
  quantity: "Quantity",
  register_number: "Register #",
  reporting_basis: "Basis",
  salesperson: "Salesperson",
  staff_name: "Staff",
  tax_collected: "Tax Collected",
  total_amount: "Total Amount",
  total_cost: "Total Cost",
  total_sales: "Sales Total",
  transaction_count: "Transactions",
  transaction_display_id: "Transaction #",
  unit_cost: "Unit Cost",
  unit_price: "Unit Price",
  units_sold: "Units Sold",
  vendor_display_name: "Vendor",
  wedding_party_name: "Wedding Party",
};

function titleize(value) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bId\b/g, "ID")
    .replace(/\bQbo\b/g, "QBO")
    .replace(/\bRms\b/g, "RMS")
    .replace(/\bSku\b/g, "SKU");
}

function fieldLabel(fieldName) {
  return FIELD_LABELS[fieldName] || titleize(fieldName);
}

function shouldHideField(fieldName) {
  const name = fieldName.toLowerCase();
  if (name === "id") return true;
  if (name === "order_short_id") return false;
  if (name.endsWith("_id") && !name.endsWith("_display_id")) return true;
  if (name.endsWith("_json") || name === "metadata" || name.endsWith("_metadata")) return true;
  if (name.includes("auth_code") || name.includes("provider_payment_id")) return true;
  return false;
}

function tableLabel(tableName) {
  return STAFF_TABLE_LABELS[tableName] || titleize(tableName);
}

function parseEnvFile(path) {
  if (!fs.existsSync(path)) return {};
  const parsed = {};
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index);
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

const fileEnv = parseEnvFile("server/.env");
const env = { ...fileEnv, ...process.env };
const metabaseUrl = (
  env.METABASE_URL ||
  env.RIVERSIDE_METABASE_UPSTREAM ||
  DEFAULT_METABASE_URL
).replace(/\/+$/, "");
const username = env.RIVERSIDE_METABASE_ADMIN_EMAIL;
const password = env.RIVERSIDE_METABASE_ADMIN_PASSWORD;
const reportingDbHost = env.RIVERSIDE_METABASE_REPORTING_DB_HOST || "db";
const reportingDbPort = Number(env.RIVERSIDE_METABASE_REPORTING_DB_PORT || 5432);
const reportingDbName = env.RIVERSIDE_METABASE_REPORTING_DB_NAME || "riverside_os";
const reportingDbUser = env.RIVERSIDE_METABASE_REPORTING_DB_USER || "metabase_ro";
const reportingDbPassword =
  env.RIVERSIDE_METABASE_REPORTING_DB_PASSWORD || env.METABASE_REPORTING_DB_PASSWORD || "";

if (!username || !password) {
  console.error("Missing RIVERSIDE_METABASE_ADMIN_EMAIL or RIVERSIDE_METABASE_ADMIN_PASSWORD.");
  process.exit(1);
}

async function metabaseFetch(path, options = {}) {
  const response = await fetch(`${metabaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function login() {
  const response = await metabaseFetch("/api/session", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return response.id;
}

async function findRiversideDatabase(headers) {
  const response = await metabaseFetch("/api/database", { headers });
  const databases = Array.isArray(response.data) ? response.data : response;
  const database = databases.find((candidate) =>
    /riverside/i.test(candidate.name || "") ||
    /riverside_os/i.test(candidate.details?.dbname || "")
  );
  if (!database) {
    throw new Error("Could not find a Metabase database named for Riverside.");
  }
  return database;
}

async function loadDatabase(databaseId, headers) {
  return metabaseFetch(`/api/database/${databaseId}`, { headers });
}

async function enforceReportingOnlyConnection(database, headers) {
  const current = await loadDatabase(database.id, headers);
  const details = current.details || {};
  const alreadyReportingOnly =
    details.user === reportingDbUser &&
    details.dbname === reportingDbName &&
    details["schema-filters-type"] === "inclusion" &&
    details["schema-filters-patterns"] === "reporting";

  if (alreadyReportingOnly) {
    return false;
  }
  if (!reportingDbPassword.trim()) {
    throw new Error(
      "Metabase is not using the reporting-only metabase_ro connection. Set RIVERSIDE_METABASE_REPORTING_DB_PASSWORD and rerun this script.",
    );
  }

  await metabaseFetch(`/api/database/${database.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: current.name,
      engine: current.engine,
      details: {
        ...details,
        host: reportingDbHost,
        port: reportingDbPort,
        dbname: reportingDbName,
        user: reportingDbUser,
        password: reportingDbPassword,
        "schema-filters-type": "inclusion",
        "schema-filters-patterns": "reporting",
        "write-data-connection": false,
      },
      auto_run_queries: current.auto_run_queries,
      cache_ttl: current.cache_ttl,
      is_full_sync: true,
      schedules: current.schedules,
    }),
  });
  return true;
}

async function syncDatabase(databaseId, headers) {
  await metabaseFetch(`/api/database/${databaseId}/sync_schema`, {
    method: "POST",
    headers,
  });
  await metabaseFetch(`/api/database/${databaseId}/rescan_values`, {
    method: "POST",
    headers,
  });
}

async function loadMetadata(databaseId, headers) {
  return metabaseFetch(`/api/database/${databaseId}/metadata`, { headers });
}

async function applyFieldModel(metadata, headers) {
  let updates = 0;
  const hideRawTables = env.RIVERSIDE_METABASE_HIDE_RAW_TABLES !== "false";

  for (const table of metadata.tables || []) {
    if (hideRawTables && table.schema !== "reporting") {
      await metabaseFetch(`/api/table/${table.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ visibility_type: "hidden" }),
      });
      updates += 1;
      continue;
    }
    if (table.schema !== "reporting") continue;

    await metabaseFetch(`/api/table/${table.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        display_name: tableLabel(table.name),
      }),
    });
    updates += 1;

    const tableConfig = FIELD_MODEL[table.name] || { show: {}, hide: [] };
    for (const field of table.fields || []) {
      const displayName = tableConfig.show[field.name] || fieldLabel(field.name);
      const shouldHide = tableConfig.hide.includes(field.name) || shouldHideField(field.name);

      await metabaseFetch(`/api/field/${field.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(
          shouldHide
            ? { visibility_type: "hidden" }
            : { display_name: displayName, visibility_type: "normal" },
        ),
      });
      updates += 1;
    }
  }
  return updates;
}

async function verifyFieldModel(databaseId, headers) {
  const metadata = await loadMetadata(databaseId, headers);
  const checks = [
    ["order_lines", "order_short_id", "Order / Transaction #", "normal"],
    ["order_lines", "product_name", "Product", "normal"],
    ["order_lines", "product_id", null, "hidden"],
    ["payment_ledger", "payer_name", "Payer Name", "normal"],
    ["payment_ledger", "provider_payment_id", null, "hidden"],
  ];

  for (const [tableName, fieldName, displayName, visibilityType] of checks) {
    const table = (metadata.tables || []).find(
      (candidate) => candidate.schema === "reporting" && candidate.name === tableName,
    );
    const field = table?.fields?.find((candidate) => candidate.name === fieldName);
    if (!field) throw new Error(`Verification failed: missing reporting.${tableName}.${fieldName}.`);
    if (displayName && field.display_name !== displayName) {
      throw new Error(
        `Verification failed: reporting.${tableName}.${fieldName} display is ${field.display_name}.`,
      );
    }
    if (field.visibility_type !== visibilityType) {
      throw new Error(
        `Verification failed: reporting.${tableName}.${fieldName} visibility is ${field.visibility_type}.`,
      );
    }
  }
}

async function verifyReportingOnlyConnection(databaseId, headers) {
  const database = await loadDatabase(databaseId, headers);
  const details = database.details || {};
  if (details.user !== reportingDbUser) {
    throw new Error(`Verification failed: Metabase database user is ${details.user}.`);
  }
  if (details.dbname !== reportingDbName) {
    throw new Error(`Verification failed: Metabase database name is ${details.dbname}.`);
  }
  if (details["schema-filters-type"] !== "inclusion") {
    throw new Error("Verification failed: Metabase schema filter is not inclusion-only.");
  }
  if (details["schema-filters-patterns"] !== "reporting") {
    throw new Error("Verification failed: Metabase schema filter is not limited to reporting.");
  }
}

async function main() {
  const sessionId = await login();
  const headers = { "x-metabase-session": sessionId };
  const database = await findRiversideDatabase(headers);
  const connectionUpdated = await enforceReportingOnlyConnection(database, headers);
  await syncDatabase(database.id, headers);
  const metadata = await loadMetadata(database.id, headers);
  const updates = await applyFieldModel(metadata, headers);
  await verifyReportingOnlyConnection(database.id, headers);
  await verifyFieldModel(database.id, headers);
  console.log(
    `Metabase reporting metadata refreshed for ${database.name}; connection_updated=${connectionUpdated}; field_updates=${updates}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
