#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const requireReleaseClearance = process.argv.includes("--require-release-clearance");
const emitReleaseWarning = process.argv.includes("--release-warning");

const expectedHashes = new Map([
  [
    "docs/incidents/evidence/2026-07-21-counterpoint-repair-execution-evidence.json",
    "bbbb9d679078a400beb7180a1874990251282d0d3337a572c95729791abfee30",
  ],
  [
    "docs/incidents/evidence/2026-07-22-counterpoint-status-recovery-manifest.csv",
    "8310560c1c89350d4ab15ccb4f0a6f65d69dd4dc5775acfa0627bc3aa20eb21d",
  ],
  [
    "docs/incidents/evidence/2026-07-22-counterpoint-status-recovery-execution-evidence.json",
    "343efbbdbb92b472a8a5a2d8dadb6bfa0b23c042e1d483118b1225eebf73cc89",
  ],
  [
    "docs/incidents/evidence/2026-07-22-counterpoint-status-recovery-cross-ledger-v4.csv",
    "5b446364230ec495e5c45eadd657ceec6d581db1c9ad81bb8e2c0fc920ed6f5c",
  ],
  [
    "docs/incidents/evidence/2026-07-23-counterpoint-cross-ledger-production-execution-evidence.json",
    "3457fa839233a0310e8c4b42dede580f08dfd2f7c311ccb21d52f7274ee54638",
  ],
  [
    "docs/incidents/evidence/2026-07-22-counterpoint-balance-recovery-cohort-ledger-evidence.json",
    "169b2da52e0a2efd392a9f7ec9323a7ddca840f8c8fb83d7fc94483ceefdc6cb",
  ],
  [
    "docs/incidents/evidence/2026-07-22-qbo-exposure-evidence.json",
    "bde4a61acdc1f4bc15bcd2bf149fbff28e2a923c6cfa3564ecbff5a50094717e",
  ],
  [
    "docs/incidents/evidence/2026-07-22-backup-reconstruction-evidence.json",
    "6eb63bad17b2aed0ed4d61c2d3e2c7960587f18bd839d2a5a263c534328ed068",
  ],
  [
    "docs/incidents/evidence/2026-07-22-forensic-retention-evidence.json",
    "e0f78c828aa8eec9c8740230938e5a79579980947cba7ea0923c97f775c59fea",
  ],
  [
    "scripts/audit-counterpoint-fulfillment-incident.sql",
    "830ed1e4334165a2d0ddc49b3bc0bd37d2abdcd76808bdfe1b4e28dab6bb1e54",
  ],
]);

const expectedFailedIds = [
  "TXN-566008",
  "TXN-566015",
  "TXN-566043",
  "TXN-566051",
  "TXN-566114",
  "TXN-566162",
  "TXN-566219",
  "TXN-566276",
  "TXN-566432",
];
const expectedBalanceCohortIds = [
  ...expectedFailedIds,
  "TXN-566139",
].sort();

function fail(message) {
  console.error(`Incident evidence check failed: ${message}`);
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) fail("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const [header, ...values] = rows;
  if (!header) fail("CSV is empty");
  return values
    .filter((value) => value.some((fieldValue) => fieldValue !== ""))
    .map((value) => Object.fromEntries(header.map((key, index) => [key, value[index] ?? ""])));
}

function countBy(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
  }
  return counts;
}

function moneyToCents(value) {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(value);
  if (!match) fail(`invalid money value: ${value}`);
  const cents = BigInt(match[2]) * 100n + BigInt(match[3]);
  return match[1] === "-" ? -cents : cents;
}

function sorted(values) {
  return [...values].sort();
}

for (const [path, expectedHash] of expectedHashes) {
  if (!existsSync(path)) fail(`missing artifact ${path}`);
  const actualHash = sha256(path);
  if (actualHash !== expectedHash) {
    fail(`${path} SHA-256 ${actualHash} does not match ${expectedHash}`);
  }
}

const manifestRows = parseCsv(
  readFileSync(
    "docs/incidents/evidence/2026-07-22-counterpoint-status-recovery-manifest.csv",
    "utf8",
  ),
);
if (manifestRows.length !== 568) fail(`recovery manifest has ${manifestRows.length} rows, expected 568`);
if (new Set(manifestRows.map((row) => row.transaction_id)).size !== 567) {
  fail("recovery manifest does not contain exactly 567 unique Transaction Record IDs");
}
if (new Set(manifestRows.map((row) => row.audit_event_id)).size !== 568) {
  fail("recovery manifest does not contain exactly 568 unique recovery audit event IDs");
}

const ledgerRows = parseCsv(
  readFileSync(
    "docs/incidents/evidence/2026-07-22-counterpoint-status-recovery-cross-ledger-v4.csv",
    "utf8",
  ),
);
if (ledgerRows.length !== 567) fail(`cross-ledger evidence has ${ledgerRows.length} rows, expected 567`);
const manifestTransactionIds = sorted(
  new Set(manifestRows.map((row) => row.transaction_id)),
);
const ledgerTransactionIds = ledgerRows.map((row) => row.transaction_id);
if (
  new Set(ledgerTransactionIds).size !== 567 ||
  JSON.stringify(sorted(ledgerTransactionIds)) !== JSON.stringify(manifestTransactionIds)
) {
  fail("cross-ledger evidence is not an exact one-row-per-manifest-Transaction set");
}
const statusCounts = countBy(ledgerRows, "verification_status");
for (const [status, expectedCount] of [
  ["review_required_traceability_gaps", 557],
  ["review_required_current_exception", 1],
  ["failed_recovery_removed_fulfilled_recognition", 9],
]) {
  if (statusCounts.get(status) !== expectedCount) {
    fail(`${status} count is ${statusCounts.get(status) ?? 0}, expected ${expectedCount}`);
  }
}
if ([...statusCounts.values()].reduce((total, count) => total + count, 0) !== 567) {
  fail("cross-ledger evidence contains an unexpected verification status");
}

const manifestByTransaction = new Map();
for (const row of manifestRows) {
  const rows = manifestByTransaction.get(row.transaction_id) ?? [];
  rows.push(row);
  manifestByTransaction.set(row.transaction_id, rows);
}
for (const ledgerRow of ledgerRows) {
  const rows = manifestByTransaction.get(ledgerRow.transaction_id) ?? [];
  const manifestRepairIds = sorted(rows.map((row) => row.repair_id));
  const ledgerRepairIds = sorted(ledgerRow.repair_ids.split(";").filter(Boolean));
  const manifestAuditIds = sorted(rows.map((row) => row.audit_event_id));
  const ledgerAuditIds = sorted(
    ledgerRow.recovery_audit_event_ids.split(";").filter(Boolean),
  );
  if (
    rows.length !== Number(ledgerRow.correction_event_count) ||
    rows.some((row) => row.display_id !== ledgerRow.display_id) ||
    JSON.stringify(manifestRepairIds) !== JSON.stringify(ledgerRepairIds) ||
    JSON.stringify(manifestAuditIds) !== JSON.stringify(ledgerAuditIds)
  ) {
    fail(`recovery manifest does not cross-link to v4 ledger row ${ledgerRow.display_id}`);
  }
}

const failedRows = ledgerRows.filter(
  (row) => row.verification_status === "failed_recovery_removed_fulfilled_recognition",
);
if (JSON.stringify(sorted(failedRows.map((row) => row.display_id))) !== JSON.stringify(expectedFailedIds)) {
  fail("failed recognition-removal Transaction Record IDs changed");
}
const failedTotals = failedRows.reduce(
  (totals, row) => ({
    price: totals.price + moneyToCents(row.total_price),
    paid: totals.paid + moneyToCents(row.amount_paid),
    due: totals.due + moneyToCents(row.balance_due),
    lines: totals.lines + Number(row.fulfilled_line_count),
    inventory: totals.inventory + Number(row.inventory_movement_count),
    loyalty: totals.loyalty + Number(row.accrual_count) + Number(row.loyalty_ledger_count),
  }),
  { price: 0n, paid: 0n, due: 0n, lines: 0, inventory: 0, loyalty: 0 },
);
if (
  failedTotals.price !== 295700n ||
  failedTotals.paid !== 203052n ||
  failedTotals.due !== 92648n ||
  failedTotals.lines !== 22 ||
  failedTotals.inventory !== 20 ||
  failedTotals.loyalty !== 18
) {
  fail(`failed recognition-removal totals changed: ${JSON.stringify(failedTotals, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
}

const cohort = JSON.parse(
  readFileSync(
    "docs/incidents/evidence/2026-07-22-counterpoint-balance-recovery-cohort-ledger-evidence.json",
    "utf8",
  ),
);
if (!Array.isArray(cohort.transaction_records) || cohort.transaction_records.length !== 10) {
  fail("positive-balance cohort raw evidence must contain exactly 10 records");
}
const cohortIds = sorted(
  cohort.transaction_records.map((record) => record.transaction?.display_id),
);
if (JSON.stringify(cohortIds) !== JSON.stringify(expectedBalanceCohortIds)) {
  fail("positive-balance cohort raw evidence IDs changed");
}
const serializedCohort = JSON.stringify(cohort);
for (const forbidden of [
  "provider_auth_code",
  "authorization_code",
  "card_number",
  "cvv",
  "cvc",
  "track_data",
  "raw_response",
]) {
  if (serializedCohort.includes(`\"${forbidden}\"`)) {
    fail(`positive-balance cohort evidence contains forbidden field ${forbidden}`);
  }
}

const ledgerByTransaction = new Map(
  ledgerRows.map((row) => [row.transaction_id, row]),
);
for (const record of cohort.transaction_records) {
  const transaction = record.transaction;
  const ledgerRow = ledgerByTransaction.get(transaction.id);
  if (!ledgerRow || ledgerRow.display_id !== transaction.display_id) {
    fail(`raw cohort record does not cross-link to v4 ledger: ${transaction.display_id}`);
  }
  const businessLines = record.lines.filter((line) => !line.is_internal);
  const openLines = businessLines.filter((line) => !line.is_fulfilled);
  const fulfilledLines = businessLines.filter((line) => line.is_fulfilled);
  const openLinesWithFulfilledTimestamp = openLines.filter((line) => line.fulfilled_at != null);
  const rawRepairEvents = record.activity_audit.filter((event) =>
    [
      "counterpoint-open-doc-status-2026-07-22",
      "counterpoint-open-doc-balance-status-2026-07-22",
    ].includes(event.metadata_evidence?.repair_id),
  );
  const expectedAuditIds = sorted(
    (manifestByTransaction.get(transaction.id) ?? []).map((row) => row.audit_event_id),
  );
  const rawAuditIds = sorted(rawRepairEvents.map((event) => event.id));
  const allocatedTenderTotal = record.payment_evidence.allocations.reduce(
    (sum, allocation) =>
      sum + moneyToCents(Number(allocation.amount_allocated).toFixed(2)),
    0n,
  );
  if (
    ledgerRow.current_status !== transaction.status ||
    (ledgerRow.current_fulfilled_at || null) !== transaction.fulfilled_at ||
    (ledgerRow.current_header_recognition_at || null) !== transaction.current_recognition_at ||
    moneyToCents(ledgerRow.total_price) !==
      moneyToCents(Number(transaction.total_price).toFixed(2)) ||
    moneyToCents(ledgerRow.amount_paid) !==
      moneyToCents(Number(transaction.amount_paid).toFixed(2)) ||
    moneyToCents(ledgerRow.balance_due) !==
      moneyToCents(Number(transaction.balance_due).toFixed(2)) ||
    Number(ledgerRow.business_line_count) !== businessLines.length ||
    Number(ledgerRow.open_line_count) !== openLines.length ||
    Number(ledgerRow.fulfilled_line_count) !== fulfilledLines.length ||
    Number(ledgerRow.open_lines_with_fulfilled_timestamp) !==
      openLinesWithFulfilledTimestamp.length ||
    Number(ledgerRow.allocation_count) !== record.payment_evidence.allocations.length ||
    moneyToCents(ledgerRow.allocated_tender_total) !== allocatedTenderTotal ||
    Number(ledgerRow.inventory_movement_count) !== record.inventory_evidence.movements.length ||
    Number(ledgerRow.commission_event_count) !== record.commission_events.length ||
    Number(ledgerRow.accrual_count) !== record.loyalty_accruals.length ||
    Number(ledgerRow.loyalty_ledger_count) !== record.loyalty_ledger.length ||
    Number(ledgerRow.legacy_qbo_outbox_count) !== record.qbo_outbox.length ||
    Number(ledgerRow.recovery_audit_count) !== rawRepairEvents.length ||
    JSON.stringify(expectedAuditIds) !== JSON.stringify(rawAuditIds) ||
    record.lines.some((line) => line.transaction_id !== transaction.id) ||
    record.payment_evidence.allocations.some(
      (allocation) => allocation.target_transaction_id !== transaction.id,
    ) ||
    record.inventory_evidence.movements.some(
      (movement) =>
        movement.reference_table !== "transactions" ||
        movement.reference_id !== transaction.id,
    ) ||
    record.commission_events.some((event) => event.transaction_id !== transaction.id) ||
    record.loyalty_accruals.some((event) => event.transaction_id !== transaction.id) ||
    record.loyalty_ledger.some((event) => event.transaction_id !== transaction.id)
  ) {
    fail(`raw cohort evidence does not reconcile to v4 ledger: ${transaction.display_id}`);
  }
}

const failedRawRecords = cohort.transaction_records.filter((record) =>
  expectedFailedIds.includes(record.transaction?.display_id),
);
const rawDownstreamTotals = failedRawRecords.reduce(
  (totals, record) => ({
    allocations: totals.allocations + record.payment_evidence.allocations.length,
    allocated:
      totals.allocated +
      record.payment_evidence.allocations.reduce(
        (sum, allocation) => sum + moneyToCents(Number(allocation.amount_allocated).toFixed(2)),
        0n,
      ),
    commissions: totals.commissions + record.commission_events.length,
    returns: totals.returns + record.return_lines.length,
    qbo: totals.qbo + record.qbo_outbox.length,
    operational: totals.operational + record.operational_outbox.length,
  }),
  { allocations: 0, allocated: 0n, commissions: 0, returns: 0, qbo: 0, operational: 0 },
);
if (
  rawDownstreamTotals.allocations !== 16 ||
  rawDownstreamTotals.allocated !== 203052n ||
  rawDownstreamTotals.commissions !== 0 ||
  rawDownstreamTotals.returns !== 0 ||
  rawDownstreamTotals.qbo !== 0 ||
  rawDownstreamTotals.operational !== 0
) {
  fail(
    `failed recognition-removal downstream totals changed: ${JSON.stringify(rawDownstreamTotals, (_, value) => typeof value === "bigint" ? value.toString() : value)}`,
  );
}

const recoveryExecution = JSON.parse(
  readFileSync(
    "docs/incidents/evidence/2026-07-22-counterpoint-status-recovery-execution-evidence.json",
    "utf8",
  ),
);
if (
  recoveryExecution.execution_context?.normal_ros_api_or_staff_ui !== false ||
  recoveryExecution.execution_context?.authenticated_staff_actor_retained_by_ros !== false ||
  recoveryExecution.execution_context?.manager_approval_retained_by_ros !== false ||
  recoveryExecution.operations?.length !== 2 ||
  recoveryExecution.operations[0]?.scope?.asserted_record_count !== 558 ||
  recoveryExecution.operations[0]?.result?.transaction_headers_updated !== 558 ||
  recoveryExecution.operations[0]?.result?.activity_rows_inserted !== 558 ||
  recoveryExecution.operations[1]?.scope?.asserted_record_count !== 10 ||
  recoveryExecution.operations[1]?.result?.transaction_headers_updated !== 10 ||
  recoveryExecution.operations[1]?.result?.activity_rows_inserted !== 10 ||
  recoveryExecution.combined_scope?.unique_transaction_records !== 567
) {
  fail("sanitized recovery execution evidence changed its proven execution contract");
}
if (JSON.stringify(recoveryExecution).includes("PGPASSWORD")) {
  fail("sanitized recovery execution evidence contains connection material");
}

const productionAuditExecution = JSON.parse(
  readFileSync(
    "docs/incidents/evidence/2026-07-23-counterpoint-cross-ledger-production-execution-evidence.json",
    "utf8",
  ),
);
const retainedV4Path =
  "docs/incidents/evidence/2026-07-22-counterpoint-status-recovery-cross-ledger-v4.csv";
const productionAuditSql = readFileSync(
  "scripts/audit-counterpoint-fulfillment-incident.sql",
  "utf8",
);
const executableProductionAuditSql = productionAuditSql.replace(/--.*$/gm, "").trim();
const productionAuditStatementCount = executableProductionAuditSql
  .replace(/'(?:''|[^'])*'/g, "''")
  .split(";")
  .filter((statement) => statement.trim()).length;
if (
  productionAuditExecution.execution?.production_mutation_performed !== false ||
  !productionAuditExecution.execution?.read_only_controls?.includes(
    "PGOPTIONS=-c default_transaction_read_only=on",
  ) ||
  productionAuditExecution.query?.sha256 !==
    expectedHashes.get("scripts/audit-counterpoint-fulfillment-incident.sql") ||
  productionAuditExecution.query?.sql_is_select_only !== true ||
  productionAuditExecution.query?.in_file_read_only_transaction_assertion !== false ||
  !executableProductionAuditSql.startsWith("WITH recovery_events AS") ||
  /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO)\b/i.test(
    executableProductionAuditSql,
  ) ||
  productionAuditStatementCount !== 1 ||
  productionAuditExecution.retained_output?.sha256 !== expectedHashes.get(retainedV4Path) ||
  productionAuditExecution.retained_output?.bytes !== readFileSync(retainedV4Path).length ||
  productionAuditExecution.completion?.rows !== ledgerRows.length ||
  productionAuditExecution.completion?.verification_status_counts
    ?.review_required_traceability_gaps !== 557 ||
  productionAuditExecution.completion?.verification_status_counts
    ?.review_required_current_exception !== 1 ||
  productionAuditExecution.completion?.verification_status_counts
    ?.failed_recovery_removed_fulfilled_recognition !== 9 ||
  productionAuditExecution.completion?.verification_status_counts?.verified !== 0
) {
  fail("production cross-ledger execution evidence no longer binds the SQL and v4 output");
}
if (JSON.stringify(productionAuditExecution).includes("PGPASSWORD=")) {
  fail("sanitized production audit execution evidence contains connection material");
}

const preRetag = readFileSync("scripts/check-pre-retag.mjs", "utf8");
if (
  !preRetag.includes("Counterpoint fulfillment incident disclosure") ||
  !preRetag.includes('"--release-warning"') ||
  preRetag.includes('"--require-release-clearance"')
) {
  fail("pre-retag no longer preserves the non-blocking incident disclosure");
}

const incident = readFileSync(
  "docs/incidents/2026-07-21-counterpoint-fulfillment-status-incident.md",
  "utf8",
);
for (const required of [
  "557 traceability reviews",
  "nine failed recognition recoveries",
  "16 payment allocations totaling `$2,030.52`",
  "**Zero records are classified as verified.**",
  "343efbbdbb92b472a8a5a2d8dadb6bfa0b23c042e1d483118b1225eebf73cc89",
  "3457fa839233a0310e8c4b42dede580f08dfd2f7c311ccb21d52f7274ee54638",
  "5b446364230ec495e5c45eadd657ceec6d581db1c9ad81bb8e2c0fc920ed6f5c",
  "169b2da52e0a2efd392a9f7ec9323a7ddca840f8c8fb83d7fc94483ceefdc6cb",
  "830ed1e4334165a2d0ddc49b3bc0bd37d2abdcd76808bdfe1b4e28dab6bb1e54",
]) {
  if (!incident.includes(required)) fail(`incident report is missing: ${required}`);
}

for (const activePath of [
  "migrations/150_bulk_fulfillment_operation_guard.sql",
  "server/src/api/fulfillment_integrity.rs",
  "server/src/logic/fulfillment_recovery.rs",
  "client/src/components/settings/CounterpointFulfillmentRecoveryPanel.tsx",
  "client/src/components/settings/CounterpointPickupRecognitionRecoveryPanel.tsx",
]) {
  if (existsSync(activePath)) fail(`held recovery design leaked into executable path: ${activePath}`);
}
for (const [path, forbidden] of [
  ["server/src/embedded_migrations.rs", "150_bulk_fulfillment_operation_guard"],
  ["server/src/api/mod.rs", "fulfillment_integrity"],
  ["server/src/logic/mod.rs", "fulfillment_recovery"],
  ["client/src/components/settings/CounterpointSyncSettingsPanel.tsx", "CounterpointFulfillmentRecoveryPanel"],
  ["scripts/validate_migration_layout.sh", "150_bulk_fulfillment_operation_guard"],
]) {
  if (readFileSync(path, "utf8").includes(forbidden)) {
    fail(`${path} still contains executable held-design reference ${forbidden}`);
  }
}
const repairScript = readFileSync(
  "scripts/repair-current-counterpoint-imports.mjs",
  "utf8",
);
const repairGuardIndex = repairScript.indexOf("if (apply && !skipFinancials)");
const repairConnectionIndex = repairScript.indexOf(
  "const pool = await connectCounterpoint()",
);
const transactionUpdateStart = repairScript.indexOf("UPDATE transactions t");
const transactionUpdateEnd = repairScript.indexOf(
  "INSERT INTO product_variant_barcode_aliases",
  transactionUpdateStart,
);
const transactionUpdateSql =
  transactionUpdateStart >= 0 && transactionUpdateEnd > transactionUpdateStart
    ? repairScript.slice(transactionUpdateStart, transactionUpdateEnd)
    : "";
if (
  repairGuardIndex < 0 ||
  repairConnectionIndex < 0 ||
  repairGuardIndex > repairConnectionIndex ||
  !repairScript.includes("Direct Counterpoint financial repair apply is disabled") ||
  transactionUpdateSql.length === 0 ||
  /\bstatus\s*=/.test(transactionUpdateSql) ||
  /\bfulfilled_at\s*=/.test(transactionUpdateSql)
) {
  fail("the initiating direct financial repair path is not disabled before connection/work");
}

console.log(
  "Counterpoint fulfillment incident evidence verified: 568 events / 567 records / 557 traceability reviews / 1 current exception / 9 failed recognition recoveries / 0 verified.",
);

if (requireReleaseClearance) {
  fail(
    "release clearance denied: all 567 records remain unresolved (557 traceability reviews, 1 current exception, 9 failed recognition recoveries, 0 verified)",
  );
}

if (emitReleaseWarning) {
  console.warn(
    "RELEASE WARNING: the July 21 false-fulfillment incident remains unresolved: 557 traceability reviews, 1 current exception, 9 failed recognition recoveries, and 0 verified records.",
  );
  console.warn(
    "Release may continue by operator decision, but release notes and retained evidence must not describe this incident or the 567-record cohort as resolved.",
  );
}
