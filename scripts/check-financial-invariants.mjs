#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const passes = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function lineOf(content, needle) {
  const index =
    typeof needle === "string" ? content.indexOf(needle) : content.search(needle);
  if (index < 0) return 1;
  return content.slice(0, index).split(/\r?\n/).length;
}

function pass(message) {
  passes.push(message);
}

function fail(message, file, detail) {
  failures.push({ message, file, detail });
}

function assert(condition, message, file, detail) {
  if (condition) {
    pass(message);
  } else {
    fail(message, file, detail);
  }
}

function assertIncludes(content, needle, message, file, detail) {
  assert(content.includes(needle), message, file, detail ?? `Missing: ${needle}`);
}

function assertMatches(content, pattern, message, file, detail) {
  assert(pattern.test(content), message, file, detail ?? `Pattern not found: ${pattern}`);
}

function assertNotMatches(content, pattern, message, file, detail) {
  const matched = pattern.test(content);
  assert(
    !matched,
    message,
    matched ? `${file}:${lineOf(content, pattern)}` : file,
    detail ?? `Forbidden pattern found: ${pattern}`,
  );
}

function cents(value) {
  if (!Number.isInteger(value)) {
    throw new Error(`Invariant fixture values must be integer cents: ${value}`);
  }
  return value;
}

function checkScenarioLedgerMath() {
  const receiving = {
    units: 10,
    invoiceUnitCost: cents(4_000),
    supplierFreight: cents(1_250),
  };
  const merchandiseReceiving = receiving.units * receiving.invoiceUnitCost;
  const forbiddenFreightCapitalized =
    receiving.units * receiving.invoiceUnitCost + receiving.supplierFreight;

  assert(
    merchandiseReceiving === cents(40_000),
    "Fixture: merchandise receiving uses invoice unit cost only",
    "scripts/check-financial-invariants.mjs",
    "10 units at $40.00 must debit inventory and credit receiving clearing for $400.00.",
  );
  assert(
    forbiddenFreightCapitalized !== merchandiseReceiving,
    "Fixture: supplier freight remains outside item cost",
    "scripts/check-financial-invariants.mjs",
    "The rejected capitalization value is $412.50; the accepted inventory value is $400.00 plus separate $12.50 freight.",
  );

  const customerShipment = {
    merchandiseSubtotal: cents(20_000),
    customerShippingCharged: cents(1_200),
    supplierFreight: cents(1_250),
  };
  assert(
    customerShipment.customerShippingCharged !== customerShipment.supplierFreight,
    "Fixture: customer shipping and supplier freight are independent lanes",
    "scripts/check-financial-invariants.mjs",
    "The same word shipping must not let customer charges and vendor freight share accounting code paths.",
  );
  assert(
    customerShipment.merchandiseSubtotal + customerShipment.customerShippingCharged === cents(21_200),
    "Fixture: customer shipping can be part of customer total without becoming merchandise revenue",
    "scripts/check-financial-invariants.mjs",
    "Customer total may include shipping; merchandise revenue and shipping income remain separate journal lines.",
  );

  const giftCard = {
    purchasedLoad: cents(5_000),
    redemption: cents(3_000),
  };
  assert(
    giftCard.purchasedLoad > giftCard.redemption,
    "Fixture: purchased gift-card load is liability until redemption",
    "scripts/check-financial-invariants.mjs",
    "Gift-card sale must not be merchandise revenue; redemption relieves liability.",
  );

  const weddingProgram = {
    paidSuitUnits: 5,
    freeSuitUnits: 1,
    unitRevenue: cents(24_900),
    unitCost: cents(10_000),
  };
  const paidRevenue = weddingProgram.paidSuitUnits * weddingProgram.unitRevenue;
  const totalCost =
    (weddingProgram.paidSuitUnits + weddingProgram.freeSuitUnits) * weddingProgram.unitCost;
  const promoValue = weddingProgram.freeSuitUnits * weddingProgram.unitRevenue;
  assert(
    paidRevenue === cents(124_500) && totalCost === cents(60_000) && promoValue === cents(24_900),
    "Fixture: wedding promo economics track paid units, free units, cost, and promo value separately",
    "scripts/check-financial-invariants.mjs",
    "The free suit cannot inflate paid-unit revenue or disappear from profit reporting.",
  );
}

function checkReceivingAndFreightSource() {
  const qboFile = "server/src/logic/qbo_journal.rs";
  const qbo = read(qboFile);

  assertMatches(
    qbo,
    /SUM\(\(COALESCE\(it\.unit_cost,\s*0\)\s*\*\s*it\.quantity_delta\)::numeric\(14,\s*2\)\)\s+AS total_value/,
    "QBO inventory movement uses item unit cost only",
    qboFile,
    "Receiving, adjustment, damage, RTV, and physical inventory value must not add supplier freight into inventory cost.",
  );
  assertNotMatches(
    qbo,
    /COALESCE\(it\.unit_cost,\s*0\)\s*\+\s*COALESCE\(it\.landed_cost_component,\s*0\)[\s\S]{0,240}AS total_value/,
    "QBO inventory movement does not capitalize supplier freight",
    qboFile,
    "Do not add the legacy freight allocation field into inventory receiving/clearing value.",
  );
  assertIncludes(
    qbo,
    'ledger_mapping(pool, "COGS_FREIGHT")',
    "QBO supplier freight uses the inbound freight expense mapping",
    qboFile,
  );
  assertIncludes(
    qbo,
    'ledger_mapping(pool, "INV_RECEIVING_CLEARING")',
    "QBO supplier freight offsets receiving clearing separately",
    qboFile,
  );
  assertIncludes(
    qbo,
    'memo: format!("Inbound freight / shipping cost for {activity_date}")',
    "QBO supplier freight line is explicit and separate",
    qboFile,
  );
  assertIncludes(
    qbo,
    'memo: "Customer-charged shipping income".to_string()',
    "QBO customer shipping posts through a customer-shipping income line",
    qboFile,
  );
  assertIncludes(
    qbo,
    '"income_shipping"',
    "QBO customer shipping uses income_shipping mapping",
    qboFile,
  );
  assertIncludes(
    qbo,
    '"REVENUE_SHIPPING"',
    "QBO customer shipping has an explicit revenue fallback key",
    qboFile,
  );

  const poFile = "server/src/api/purchase_orders.rs";
  const po = read(poFile);
  assertIncludes(
    po,
    "WAC and inventory capitalization use invoice unit only; freight is booked separately.",
    "Receiving code documents invoice-unit-only inventory valuation",
    poFile,
  );
  assertMatches(
    po,
    /weighted_average_cost\(\s*stock_before,\s*cost_before,\s*row\.quantity_received_now,\s*invoice_unit,\s*\)/,
    "Receiving weighted average cost uses invoice unit cost",
    poFile,
    "Do not pass freight allocation into weighted_average_cost.",
  );
  assertIncludes(
    po,
    'freight_ledger_key: "COGS_FREIGHT"',
    "Receiving response keeps supplier freight tied to the freight ledger key",
    poFile,
  );

  const sessionsFile = "server/src/api/sessions.rs";
  const sessions = read(sessionsFile);
  assertIncludes(
    sessions,
    "(COALESCE(it.unit_cost, 0) * it.quantity_delta::numeric)",
    "Register close inventory activity uses item cost only",
    sessionsFile,
  );
  assertNotMatches(
    sessions,
    /COALESCE\(it\.unit_cost,\s*0\)\s*\+\s*COALESCE\(it\.landed_cost_component,\s*0\)/,
    "Register close inventory activity does not add freight allocation into item value",
    sessionsFile,
  );

  const reportFile = "server/src/logic/daily_report.rs";
  const report = read(reportFile);
  assertIncludes(
    report,
    "COALESCE(SUM((it.unit_cost * it.quantity_delta)::numeric(14,2)), 0)::numeric(14,2) AS cost",
    "Daily Financial Report receiving cost uses unit cost only",
    reportFile,
  );
  assertIncludes(
    report,
    "COALESCE(SUM(re.freight_total), 0)::numeric(14,2) AS freight",
    "Daily Financial Report supplier freight is shown separately",
    reportFile,
  );
}

function checkCustomerShippingAndDiscountSource() {
  const checkoutFile = "server/src/logic/transaction_checkout.rs";
  const checkout = read(checkoutFile);
  assertIncludes(
    checkout,
    "Ship current sale requires the Register Shipping action so rates, address, and shipment tracking are recorded.",
    "Checkout requires the Register Shipping action for shipped sales",
    checkoutFile,
  );
  assertIncludes(
    checkout,
    "total_price does not match server-calculated sum of cart lines and shipping",
    "Checkout validates customer total as lines plus customer shipping",
    checkoutFile,
  );
  assertIncludes(
    checkout,
    "shipping_amount_usd",
    "Checkout stores customer shipping amount on the transaction",
    checkoutFile,
  );
  assertNotMatches(
    checkout,
    /freight_total/,
    "Checkout customer shipping path does not use supplier freight fields",
    checkoutFile,
    "Customer shipping and supplier freight must not share the same field name or ledger path.",
  );

  const promoFile = "server/src/logic/store_promotions.rs";
  const promo = read(promoFile);
  assertMatches(
    promo,
    /"free_shipping"\s*=>\s*Ok\(AppliedCouponPreview\s*\{[\s\S]*?discount_amount:\s*Decimal::ZERO,[\s\S]*?free_shipping:\s*true,/,
    "Free-shipping promotions are explicit and do not become merchandise discounts",
    promoFile,
    "Free shipping must stay a shipping promotion signal, not hidden in line price or supplier freight.",
  );
  assertIncludes(
    promo,
    "discount_amount: disc",
    "Percent/fixed promotions produce explicit discount amount evidence",
    promoFile,
  );
}

function checkLiabilityAndRecognitionSource() {
  const qboFile = "server/src/logic/qbo_journal.rs";
  const qbo = read(qboFile);
  const requiredSnippets = [
    "Purchased gift card liability issued",
    "Gift card redemption (liability)",
    "Gift card redemption (loyalty/promo expense)",
    "Store credit redemption (liability)",
    "Open deposit redemption (liability)",
    "Deposit release —",
    "Revenue from deposit release",
    "Forfeited deposit liability relief",
    "Income from forfeited deposits",
    "Refund liability queued (from returns)",
    "Refund liability relieved (payouts)",
    "ORDER_RECOGNITION_TS_SQL",
  ];
  for (const snippet of requiredSnippets) {
    assertIncludes(qbo, snippet, `QBO proposal preserves ${snippet}`, qboFile);
  }
}

function checkUserFacingLabels() {
  const receivingReportFile = "client/src/components/inventory/ReceivingReport.tsx";
  const receivingReport = read(receivingReportFile);
  assertIncludes(
    receivingReport,
    "Invoice Unit",
    "Receiving report labels item cost as invoice unit cost",
    receivingReportFile,
  );
  assertIncludes(
    receivingReport,
    "Freight Alloc.",
    "Receiving report labels supplier freight as freight allocation",
    receivingReportFile,
  );
  assertNotMatches(
    receivingReport,
    /\bLanded\b|landed unit|landed cost|landedLine|landedUnit/,
    "Receiving report does not expose landed-cost language",
    receivingReportFile,
  );

  const receivingManualFile = "client/src/assets/docs/inventory-receiving-bay-manual.md";
  const receivingManual = read(receivingManualFile);
  assertIncludes(
    receivingManual,
    "Freight is not added into item cost",
    "Receiving manual states freight is separate from item cost",
    receivingManualFile,
  );

  const qboManualFile = "client/src/assets/docs/qbo-mapping-matrix-manual.md";
  const qboManual = read(qboManualFile);
  assertIncludes(
    qboManual,
    "inbound freight stays separate and is not added into item cost",
    "QBO mapping manual states receiving clearing does not capitalize freight",
    qboManualFile,
  );
}

function checkCoverageContracts() {
  const requiredFiles = [
    "client/e2e/qbo-audit-contract.spec.ts",
    "client/e2e/checkout-tender-financial-contract.spec.ts",
    "client/e2e/inventory-receiving-api.spec.ts",
    "client/e2e/gift-card-redemption-contract.spec.ts",
    "client/e2e/tax-audit-contract.spec.ts",
    "docs/finance/financial-invariants.md",
  ];
  for (const file of requiredFiles) {
    assert(exists(file), `Financial invariant coverage file exists: ${file}`, file);
  }

  const qbo = read("client/e2e/qbo-audit-contract.spec.ts");
  const qboScenarios = [
    "store credit and open deposit redemptions post liability relief in QBO",
    "gift card subtypes post to their intended QBO accounts",
    "layaways stay transaction-scoped and post deposit, pickup, and forfeiture journals",
    "proposed journal is balanced, deduped while pending, drillable, and approval-gated",
    "financial date correction and existing order edits stay on the intended QBO day",
    "store-local business date wins over UTC date near midnight",
    "shipped orders recognize in QBO on shipment event date",
  ];
  for (const scenario of qboScenarios) {
    assertIncludes(
      qbo,
      scenario,
      `QBO audit contract covers: ${scenario}`,
      "client/e2e/qbo-audit-contract.spec.ts",
    );
  }

  const receiving = read("client/e2e/inventory-receiving-api.spec.ts");
  for (const scenario of [
    "final PO receipt posts stock exactly once and duplicate retry does not double-post",
    "direct invoice receiving uses the same final posting path and remains exact-once on replay",
    "product timeline returns readable inventory history after receipt",
  ]) {
    assertIncludes(
      receiving,
      scenario,
      `Inventory receiving API contract covers: ${scenario}`,
      "client/e2e/inventory-receiving-api.spec.ts",
    );
  }

  const tender = read("client/e2e/checkout-tender-financial-contract.spec.ts");
  for (const scenario of [
    "split tender allocates exactly across current sale and existing transaction balance",
    "rounded-up cash amount records balanced transaction artifacts and QBO rounding impact",
    "mixed tender rounds only the cash residual and keeps non-cash exact",
    "non-cash tender uses exact cents without rounding adjustment",
  ]) {
    assertIncludes(
      tender,
      scenario,
      `Tender financial contract covers: ${scenario}`,
      "client/e2e/checkout-tender-financial-contract.spec.ts",
    );
  }

  const tax = read("client/e2e/tax-audit-contract.spec.ts");
  for (const scenario of [
    "ship current sale records shipping without requiring an order line",
    "ship fulfillment mode requires Register shipping quote",
    "manual below-cost discounts require manager approval unless promotion-backed",
  ]) {
    assertIncludes(
      tax,
      scenario,
      `Tax/shipping/discount audit contract covers: ${scenario}`,
      "client/e2e/tax-audit-contract.spec.ts",
    );
  }
}

function checkProductionProbeCoverage() {
  const file = "scripts/production_audit_probes.sql";
  const probes = read(file);
  const required = [
    "P1 probe: receiving events with freight missing inventory receipt rows",
    "P1 probe: supplier freight captured on receipts for accounting review",
    "P1 probe: shipped customer transactions missing shipping registry rows",
    "P1 probe: customer shipping charges accidentally stored as supplier freight",
    "P1 probe: QBO payloads that combine receiving and freight into one detail line",
  ];
  for (const snippet of required) {
    assertIncludes(probes, snippet, `Production SQL audit includes ${snippet}`, file);
  }
}

function checkReleaseWiring() {
  const packageFile = "package.json";
  const packageJson = read(packageFile);
  assertIncludes(
    packageJson,
    '"check:financial-invariants": "node scripts/check-financial-invariants.mjs"',
    "Root package exposes the financial invariant gate",
    packageFile,
  );

  const goLiveFile = "scripts/check-go-live-blockers.mjs";
  const goLive = read(goLiveFile);
  assertIncludes(
    goLive,
    "checkFinancialInvariantGate",
    "Go-live blocker script invokes the financial invariant gate",
    goLiveFile,
  );
  assertIncludes(
    goLive,
    "process.execPath",
    "Go-live blocker script starts the financial gate with the current Node executable",
    goLiveFile,
  );
  assertIncludes(
    goLive,
    'path.join(root, "scripts/check-financial-invariants.mjs")',
    "Go-live blocker script runs the financial invariant file directly",
    goLiveFile,
  );

  const preRetagFile = "scripts/check-pre-retag.mjs";
  const preRetag = read(preRetagFile);
  assertIncludes(
    preRetag,
    "go-live blocker gates",
    "Pre-retag gate inherits financial invariants through go-live blockers",
    preRetagFile,
  );
}

function main() {
  checkScenarioLedgerMath();
  checkReceivingAndFreightSource();
  checkCustomerShippingAndDiscountSource();
  checkLiabilityAndRecognitionSource();
  checkUserFacingLabels();
  checkCoverageContracts();
  checkProductionProbeCoverage();
  checkReleaseWiring();

  if (failures.length > 0) {
    console.error("Financial invariant check failed.");
    console.error("");
    for (const failure of failures) {
      console.error(`- ${failure.message}`);
      if (failure.file) console.error(`  file: ${failure.file}`);
      if (failure.detail) console.error(`  detail: ${failure.detail}`);
    }
    process.exit(1);
  }

  console.log(`Financial invariant check passed (${passes.length} gates).`);
  for (const message of passes) {
    console.log(`- ${message}`);
  }
}

main();
