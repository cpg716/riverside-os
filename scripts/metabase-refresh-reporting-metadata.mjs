#!/usr/bin/env node

import fs from "node:fs";

const DEFAULT_METABASE_URL = "http://127.0.0.1:3001";

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
      "stripe_intent_id",
    ],
  },
};

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
  for (const [tableName, tableConfig] of Object.entries(FIELD_MODEL)) {
    const table = (metadata.tables || []).find(
      (candidate) => candidate.schema === "reporting" && candidate.name === tableName,
    );
    if (!table) throw new Error(`Metabase metadata is missing reporting.${tableName}.`);

    for (const field of table.fields || []) {
      const displayName = tableConfig.show[field.name];
      const shouldHide = tableConfig.hide.includes(field.name);
      if (!displayName && !shouldHide) continue;

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
    ["order_lines", "transaction_display_id", "Transaction #", "normal"],
    ["order_lines", "item_display_name", "Item", "normal"],
    ["order_lines", "product_id", null, "hidden"],
    ["payment_ledger", "primary_transaction_display_id", "Primary Transaction #", "normal"],
    ["payment_ledger", "payer_name", "Payer Name", "normal"],
    ["payment_ledger", "stripe_intent_id", null, "hidden"],
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

async function main() {
  const sessionId = await login();
  const headers = { "x-metabase-session": sessionId };
  const database = await findRiversideDatabase(headers);
  await syncDatabase(database.id, headers);
  const metadata = await loadMetadata(database.id, headers);
  const updates = await applyFieldModel(metadata, headers);
  await verifyFieldModel(database.id, headers);
  console.log(`Metabase reporting metadata refreshed for ${database.name}; field_updates=${updates}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
