import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  parseRegisterReportMoneyToCents,
  REGISTER_REPORT_OUTPUT_ROW_LIMIT,
  registerReportCombinedRowCount,
} from "../src/components/pos/zReportPrint";
import { REPORTS_CATALOG } from "../src/lib/reportsCatalog";

const registerReportsSource = readFileSync(
  new URL("../src/components/pos/RegisterReports.tsx", import.meta.url),
  "utf8",
);
const reportPrintSource = readFileSync(
  new URL("../src/components/pos/zReportPrint.ts", import.meta.url),
  "utf8",
);
const closeRegisterSource = readFileSync(
  new URL("../src/components/pos/CloseRegisterModal.tsx", import.meta.url),
  "utf8",
);
const reportsWorkspaceSource = readFileSync(
  new URL("../src/components/reports/ReportsWorkspace.tsx", import.meta.url),
  "utf8",
);
const registerDashboardSource = readFileSync(
  new URL("../src/components/pos/RegisterDashboard.tsx", import.meta.url),
  "utf8",
);
const operationsHomeSource = readFileSync(
  new URL("../src/components/operations/OperationalHome.tsx", import.meta.url),
  "utf8",
);
const salesByHourCardSource = readFileSync(
  new URL(
    "../src/components/reports/SalesByHourSnapshotCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const insightsServerSource = readFileSync(
  new URL("../../server/src/api/insights.rs", import.meta.url),
  "utf8",
);
const registerDayServerSource = readFileSync(
  new URL("../../server/src/logic/register_day_activity.rs", import.meta.url),
  "utf8",
);
const dailyFinancialReportSource = readFileSync(
  new URL("../../server/src/logic/daily_report.rs", import.meta.url),
  "utf8",
);
const salesCommissionSource = readFileSync(
  new URL("../../server/src/logic/sales_commission.rs", import.meta.url),
  "utf8",
);
const commissionEventsSource = readFileSync(
  new URL("../../server/src/logic/commission_events.rs", import.meta.url),
  "utf8",
);
const transactionsServerSource = readFileSync(
  new URL("../../server/src/api/transactions.rs", import.meta.url),
  "utf8",
);
const sessionsServerSource = readFileSync(
  new URL("../../server/src/api/sessions.rs", import.meta.url),
  "utf8",
);
const receiptSummarySource = readFileSync(
  new URL("../src/components/pos/ReceiptSummaryModal.tsx", import.meta.url),
  "utf8",
);
const customerSelectorSource = readFileSync(
  new URL("../src/components/pos/CustomerSelector.tsx", import.meta.url),
  "utf8",
);

test.describe("Register report output integrity contracts", () => {
  test("currency labels and large totals are summed in integer cents", () => {
    expect(parseRegisterReportMoneyToCents("$58,633.00")).toBe(5_863_300);
    expect(parseRegisterReportMoneyToCents("($1,234.56)")).toBe(-123_456);
    expect(parseRegisterReportMoneyToCents("19.99")).toBe(1_999);
  });

  test("combined activity and pickup output has a single bounded cap", () => {
    expect(registerReportCombinedRowCount(12_000, 8_000)).toBe(
      REGISTER_REPORT_OUTPUT_ROW_LIMIT,
    );
    expect(registerReportCombinedRowCount(20_000, 1)).toBeGreaterThan(
      REGISTER_REPORT_OUTPUT_ROW_LIMIT,
    );
  });

  test("complete output rejects duplicate rows and incomplete detail", () => {
    expect(registerReportsSource).toContain("appendStableRegisterReportPage");
    expect(registerReportsSource).toContain(
      "assertCompleteRegisterReportPages",
    );
    expect(registerReportsSource).toContain("completeRegisterReportPayload");
    expect(registerReportsSource).toContain('complete_output", "true"');
    expect(registerReportsSource).toContain("completeOutput: true");
    expect(registerReportsSource).toContain("activityIds.has(row.id)");
    expect(registerReportsSource).toContain("pickupIds.has(row.id)");
    expect(registerReportsSource).toContain(
      "activityCount !== accumulator.expectedActivityCount",
    );
    expect(registerReportsSource).toContain(
      "pickupCount !== accumulator.expectedPickupCount",
    );
    expect(registerReportsSource).toContain(
      "did not return one complete database snapshot",
    );
  });

  test("filtered output keeps full-period summary and filtered detail scopes separate", () => {
    const printHandler = registerReportsSource.slice(
      registerReportsSource.indexOf("const handleReportOutput"),
      registerReportsSource.indexOf("const handleExportCSV"),
    );

    expect(printHandler).toContain("unfilteredPeriodSummary");
    expect(printHandler).toContain(
      "const periodSummary = unfilteredPeriodSummary ?? printSummary",
    );
    expect(printHandler).toContain("detailFilter: detailFilter || undefined");
    expect(reportPrintSource).toContain("Period Summary (All Activity)");
    expect(reportPrintSource).toContain("Filtered Transaction List");
    expect(reportPrintSource).toContain("Filtered Detail Total");
  });

  test("CSV totals, load-more requests, and count labels preserve audited semantics", () => {
    const csvHandler = registerReportsSource.slice(
      registerReportsSource.indexOf("const handleExportCSV"),
      registerReportsSource.indexOf("const submitVoidTransaction"),
    );
    const loadMoreHandler = registerReportsSource.slice(
      registerReportsSource.indexOf("const loadMoreActivity"),
      registerReportsSource.indexOf("const buildZLogParams"),
    );

    expect(csvHandler).toContain("parseRegisterReportMoneyToCents");
    expect(csvHandler).not.toContain("parseFloat");
    expect(loadMoreHandler).toContain("loadMoreRequestRef");
    expect(loadMoreHandler).toContain("signal: controller.signal");
    expect(loadMoreHandler).toContain("generation");
    expect(registerReportsSource).toContain("matching activity records");
    expect(registerReportsSource).not.toContain("summaryBooked.amount_label");
    expect(registerReportsSource).not.toContain("summary.amount_label");
    expect(csvHandler).toContain(
      'Fulfillment: activityFulfillmentLabel(a) || ""',
    );
    expect(registerReportsSource).toContain(
      'case "wedding_order":\n      return "Wedding Order";',
    );
    expect(registerReportsSource).toContain(
      "fulfillmentDisplayLabel(\n                                                  it.fulfillment",
    );
  });

  test("alterations count as sales while shipping stays outside sales and commissions", () => {
    expect(registerDayServerSource).toContain(
      'ReportBasis::Booked => "be.line_subtotal".to_string()',
    );
    expect(registerDayServerSource).toContain(
      "WHERE ln.line_subtotal <> 0 OR ln.line_tax <> 0",
    );
    expect(registerDayServerSource).toContain(
      "IN ('SHIPPING', 'ROS-SHIPPING-FEE')",
    );
    expect(registerDayServerSource).toContain(
      "shipping_total: Some(money_label",
    );
    expect(registerDayServerSource).toContain("AS is_shipping_only_sale");
    expect(registerDayServerSource).toContain('"Shipping Sale".to_string()');
    expect(registerDayServerSource).toContain(
      'line_kind: Some("shipping_service".to_string())',
    );
    const salesPivotExclusions = insightsServerSource.slice(
      insightsServerSource.indexOf("const SALES_PIVOT_EXCLUDED_LINE_KINDS_SQL"),
      insightsServerSource.indexOf("pub struct SalesPivotRow"),
    );
    expect(salesPivotExclusions).not.toContain("alteration_service");
    expect(salesPivotExclusions).not.toContain("alteration_fee");
    expect(insightsServerSource).toContain(
      "NOT IN ('SHIPPING', 'ROS-SHIPPING-FEE')",
    );
    expect(registerReportsSource).toContain(
      'if (kind === "shipping_service") return "Shipping"',
    );
    expect(registerReportsSource).toContain('"Shipping"');
    expect(registerReportsSource).toContain('"Alterations"');
    expect(registerReportsSource).toContain('"cardpresent"');
    expect(registerDayServerSource).toContain(
      "let alterations_net_total = alterations_total.0 - alteration_return_adjustments.0;",
    );
    expect(registerDayServerSource).toContain(
      "let reported_subtotal = subtotal;",
    );
    expect(registerDayServerSource).toContain(
      "e.line_kind IN ('alteration_service', 'alteration_fee')",
    );
    expect(registerDayServerSource).toContain(
      "COALESCE(e.metadata->>'reporting_excluded', '') = ''",
    );
    expect(registerDayServerSource).toContain("COALESCE(o.business_date,");
    expect(registerDayServerSource).toContain(
      "AND e.line_kind = 'pos_gift_card_load'",
    );
    expect(registerDayServerSource).toContain(
      "let gift_card_load_total = gift_card_totals.1 - gift_card_return_adjustments.0;",
    );
    expect(registerDayServerSource).toContain(
      "sales_subtotal_no_tax: money_label(reported_subtotal)",
    );
    expect(registerDayServerSource).toContain(
      "net_sales: money_label(reported_subtotal)",
    );
    const salesTotalExpression = registerDayServerSource.slice(
      registerDayServerSource.indexOf("let sales_total_expr"),
      registerDayServerSource.indexOf("let activity_shipping_expr"),
    );
    expect(salesTotalExpression).toContain("* oi.unit_price");
    expect(salesTotalExpression).not.toContain(
      "oi.unit_price + oi.state_tax + oi.local_tax",
    );
    expect(registerReportsSource).toContain("Total With Tax");
    expect(registerReportsSource).toContain(
      "function activityTotalWithTaxCents",
    );
    expect(registerReportsSource).toMatch(
      /it\.booking_event_kind\s*!==\s*"initial_booking"/,
    );
    expect(registerDayServerSource).toContain("THEN 'line_added'");
    expect(transactionsServerSource).toContain("SET event_kind = 'line_added'");
    expect(reportPrintSource).toContain("Grand Total With Tax");
    expect(reportPrintSource).toContain("periodTotalWithTaxCents");
    const subtotalHelper = registerReportsSource.slice(
      registerReportsSource.indexOf("function activitySubtotalBeforeTaxCents"),
      registerReportsSource.indexOf("function moneyFromCents"),
    );
    expect(subtotalHelper).not.toContain(
      'item.line_kind !== "alteration_service"',
    );
    expect(subtotalHelper).not.toContain(
      "parseMoneyToCents(row.alterations_total",
    );
    expect(sessionsServerSource).toContain("THEN 'shipping_service'");
    expect(reportPrintSource).toContain(
      'item.line_kind === "shipping_service"',
    );
    expect(reportPrintSource).toContain("Shipping:");
    expect(reportPrintSource).toContain("Alterations:");
    expect(dailyFinancialReportSource).not.toContain(
      "(p.pos_line_kind IS DISTINCT FROM 'alteration_service')",
    );
    expect(dailyFinancialReportSource).toContain(
      "UPPER(TRIM(COALESCE(pv.sku, ''))) NOT IN ('SHIPPING', 'ROS-SHIPPING-FEE')",
    );
    expect(salesCommissionSource).toContain(
      'matches!(sku.as_str(), "SHIPPING" | "ROS-SHIPPING-FEE")',
    );
    expect(commissionEventsSource).toContain(
      "NOT IN ('SHIPPING', 'ROS-SHIPPING-FEE')",
    );
  });

  test("Back Office and POS dashboard sales cards use canonical Daily Sales", () => {
    expect(registerDashboardSource).toContain(
      "/api/insights/register-day-activity?",
    );
    expect(registerDashboardSource).toContain('preset: "today"');
    expect(registerDashboardSource).toContain('basis: "booked"');
    expect(registerDashboardSource).toContain("payload.net_sales");
    expect(registerDashboardSource).toContain("payload.sales_count");
    expect(operationsHomeSource).toContain("money(todaySummary.net_sales)");
    expect(salesByHourCardSource).toContain('title="Sales by Hour"');
    expect(registerDashboardSource).not.toContain(
      "/api/insights/sales-by-day?",
    );
  });

  test("financial reports label booked, recognized, and tender bases distinctly", () => {
    expect(dailyFinancialReportSource).toContain("Recognized Net Sales");
    expect(dailyFinancialReportSource).toContain(
      "fulfillment / recognition date",
    );
    expect(dailyFinancialReportSource).toContain(
      "actual payment processing date",
    );
    expect(salesByHourCardSource).toContain('title="Sales by Hour"');
    expect(salesByHourCardSource).toContain("including alterations");
  });

  test("combined checkout payments stay on one sale activity", () => {
    expect(registerDayServerSource).toContain('"Deposit on Order".to_string()');
    expect(registerDayServerSource).toContain(
      '"Payment in Full on Order".to_string()',
    );
    expect(registerDayServerSource).toContain(
      "subtitle: p.target_display_id.clone()",
    );
    expect(registerDayServerSource).toContain(
      "checkout_o.id AS receipt_transaction_id",
    );
    expect(registerDayServerSource).toContain(
      "short_id: p.receipt_display_id.or(p.target_display_id)",
    );
    expect(registerDayServerSource).toContain("merge_order_payment_into_sale(");
    expect(registerDayServerSource).toContain(
      "payment_applications: Vec::new()",
    );
    expect(registerReportsSource).toContain(
      "normalizeActivityId(row.receipt_transaction_id)",
    );
    expect(registerReportsSource).toContain(
      "activityReceiptTransactionId(row)",
    );
    expect(registerReportsSource).toContain('"Payment Applied Today"');
    expect(registerReportsSource).toContain('"Total Paid Today"');
    expect(registerReportsSource).toContain("row.payment_applications?.map(");
    expect(registerReportsSource).toContain('{row.kind !== "payment" ? (');
    expect(registerReportsSource).toContain('"Deposit on Order"');
    expect(registerReportsSource).toContain('"Payment in Full on Order"');
    expect(reportPrintSource).toContain(
      'row.kind === "payment" ? "Payment Details" : "Line Items"',
    );
    expect(reportPrintSource).toContain('"Deposit on Order"');
    expect(reportPrintSource).toContain('"Payment in Full on Order"');
    expect(reportPrintSource).toContain("Payment Applied Today");
    expect(reportPrintSource).toContain("Total Paid Today");
    expect(reportPrintSource).toContain("Remaining Balance");
    expect(registerDayServerSource).not.toContain(
      "pa_same_day_sale.transaction_id = pt.id",
    );
    expect(registerDayServerSource).not.toContain(
      "WHERE checkout_o.id::text = pt.metadata->>'checkout_transaction_id'",
    );
    expect(registerDayServerSource).toContain(
      "NULLIF(TRIM(o.counterpoint_doc_ref), '')\n                    FROM '(O-[A-Za-z0-9-]+)$'",
    );
    expect(transactionsServerSource).toContain(
      "NULLIF(TRIM(target.counterpoint_doc_ref), '')\n                    FROM '(O-[A-Za-z0-9-]+)$'",
    );
    expect(registerDayServerSource).toContain(
      "FROM '(O-[A-Za-z0-9-]+)$'\n                ),\n                NULLIF(TRIM(o.display_id), '')",
    );
    expect(transactionsServerSource).toContain(
      "FROM '(O-[A-Za-z0-9-]+)$'\n                ),\n                NULLIF(TRIM(target.display_id), '')",
    );
    expect(reportPrintSource).toContain('<div class="pill">Transaction</div>');
    expect(reportPrintSource).toContain("const header = `Transaction |");
    expect(reportPrintSource).toContain("Salesperson");
    expect(reportPrintSource).toContain("Register ${t.register_lane}");
    expect(reportPrintSource).not.toContain("Lane #");
    expect(sessionsServerSource).toContain("salesperson.full_name AS salesperson_name");
    expect(sessionsServerSource).toContain("'transaction'::text AS payment_method");
    expect(sessionsServerSource).not.toContain("ELSE 'split'");
    expect(reportPrintSource).not.toContain(
      'reportLabel(transactionPaymentMethod(t))',
    );
    expect(reportPrintSource).not.toContain('? "split"');
  });

  test("receipt and customer overlays use explicit workflow state", () => {
    const receiptQueryBuilder = receiptSummarySource.slice(
      receiptSummarySource.indexOf("const buildReceiptQuery"),
      receiptSummarySource.indexOf("const shouldKickCashDrawer"),
    );

    expect(receiptQueryBuilder).toContain("!refundRequest && ids.length > 0");
    expect(receiptQueryBuilder).toContain(
      "orderPaymentLines && orderPaymentLines.length > 0",
    );
    expect(receiptQueryBuilder).not.toContain(
      'isOrderStatus(transactionDetail?.status, "fulfilled")',
    );
    expect(customerSelectorSource).toContain(
      "!addDrawerOpen && query.trim().length >= 2",
    );
  });

  test("Sale Complete separates the current checkout from prior pickup payment history", () => {
    expect(receiptSummarySource).toContain("currentTenderTotalCents");
    expect(receiptSummarySource).toContain("pickupPriorPaidCents");
    expect(receiptSummarySource).toContain("pickupBalanceRemainingCents");
    expect(receiptSummarySource).toContain("Collected at this pickup");
    expect(receiptSummarySource).toContain(
      "Previously paid before this checkout",
    );
    expect(receiptSummarySource).toContain(
      "No tender collected at this pickup",
    );
  });

  test("interactive reports render one basis and one audited page at a time", () => {
    const summaryLoader = registerReportsSource.slice(
      registerReportsSource.indexOf("const loadSummaries"),
      registerReportsSource.indexOf("const fetchCompleteSummary"),
    );

    expect(summaryLoader).toContain("const primaryBasis = reportBasis");
    expect(summaryLoader).toContain("setLoading(false)");
    expect(summaryLoader).not.toContain("Promise.all");
    expect(reportsWorkspaceSource).toContain("REGISTER_DAY_PAGE_SIZE");
    expect(reportsWorkspaceSource).toContain("loadMoreRegisterDay");
    expect(reportsWorkspaceSource).toContain("REGISTER_DAY_INTERACTIVE_LIMIT");
    expect(reportsWorkspaceSource).not.toContain(
      "while ((activitiesHaveMore || pickupsHaveMore)",
    );
  });

  test("Reports Workspace output reloads complete stable Register detail including pickups", () => {
    const completeOutputLoader = reportsWorkspaceSource.slice(
      reportsWorkspaceSource.indexOf("const fetchCompleteRegisterDayPayload"),
      reportsWorkspaceSource.indexOf("const loadMoreRegisterDay"),
    );
    const printRows = reportsWorkspaceSource.slice(
      reportsWorkspaceSource.indexOf("function registerSummaryPrintRows"),
      reportsWorkspaceSource.indexOf("function printableDataForReport"),
    );

    expect(completeOutputLoader).toContain("REGISTER_REPORT_OUTPUT_ROW_LIMIT");
    expect(completeOutputLoader).toContain("complete_output=true");
    expect(completeOutputLoader).toContain(
      "activities.length !== expectedActivityCount",
    );
    expect(completeOutputLoader).toContain(
      "pickups.length !== expectedPickupCount",
    );
    expect(completeOutputLoader).toContain("activityIds.has(id)");
    expect(completeOutputLoader).toContain("pickupIds.has(id)");
    expect(completeOutputLoader).not.toContain("while (true)");
    expect(printRows).toContain("registerDayPickupRows(payload)");
    expect(printRows).toContain("Pickup ${index + 1}");
    expect(reportsWorkspaceSource).toContain('title="Pickup records"');
    expect(reportsWorkspaceSource).toContain("pickup records.");
  });

  test("Register aggregation and complete output share repeatable-read snapshots", () => {
    const completeLoader = registerDayServerSource.slice(
      registerDayServerSource.indexOf(
        "async fn fetch_complete_register_day_summary_bounded",
      ),
      registerDayServerSource.indexOf(
        "pub async fn fetch_complete_register_day_summary(",
      ),
    );
    const pageLoader = registerDayServerSource.slice(
      registerDayServerSource.indexOf(
        "pub async fn fetch_register_day_summary_page(",
      ),
      registerDayServerSource.indexOf(
        "#[derive(Debug, Clone)]",
        registerDayServerSource.indexOf(
          "pub async fn fetch_register_day_summary_page(",
        ),
      ),
    );

    expect(registerDayServerSource).toContain(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(completeLoader).toContain(
      "fetch_register_day_summary_page_on_connection",
    );
    expect(completeLoader).toContain("transaction.commit().await");
    expect(completeLoader).toContain("validate_complete_row_bounds");
    expect(registerDayServerSource).toContain("combined_total");
    expect(pageLoader).toContain(
      "fetch_register_day_summary_page_on_connection",
    );
    expect(pageLoader).toContain("transaction.commit().await");
  });

  test("interactive load-more rejects moving pages and fills the remaining screen capacity", () => {
    const loadMoreHandler = registerReportsSource.slice(
      registerReportsSource.indexOf("const loadMoreActivity"),
      registerReportsSource.indexOf("const buildZLogParams"),
    );

    expect(loadMoreHandler).toContain(
      "registerReportSummaryTruth(page) !== registerReportSummaryTruth(current)",
    );
    expect(loadMoreHandler).toContain("repeated an existing row");
    expect(loadMoreHandler).toContain("const remainingCapacity");
    expect(loadMoreHandler).toContain("page.activities.slice(0, activityTake)");
    expect(loadMoreHandler).not.toContain("Loading this page would exceed");
  });

  test("unavailable booked comparisons never render substituted zero metrics", () => {
    const additionalMetrics = registerReportsSource.slice(
      registerReportsSource.indexOf("Additional Metrics - Compact"),
      registerReportsSource.indexOf("Combined Totals Placeholder"),
    );

    expect(additionalMetrics).toMatch(
      /summaryBooked\s*\?\s*summaryBooked\.special_order_sale_count\s*:\s*"—"/,
    );
    expect(additionalMetrics).toContain(
      'summaryBooked ? summaryBooked.pickup_count : "—"',
    );
    expect(additionalMetrics).not.toContain(
      "summaryBooked?.special_order_sale_count || 0",
    );
    expect(additionalMetrics).not.toContain(
      "summaryBooked?.new_appointment_count || 0",
    );
  });

  test("refunds-owed chart uses the remaining obligation", () => {
    const report = REPORTS_CATALOG.find(
      (candidate) => candidate.id === "returns_exchanges_refunds",
    );

    expect(report?.chartConfigs?.[0]).toMatchObject({
      title: "Refunds owed by day",
      valueKey: "refund_remaining",
      aggregateByLabel: true,
    });
    expect(report).toMatchObject({ responseKind: "audited_paged_rows" });
  });

  test("returns and refunds load a complete stable bounded snapshot before rendering or output", () => {
    const loader = reportsWorkspaceSource.slice(
      reportsWorkspaceSource.indexOf(
        "async function fetchCompleteAuditedRowsPayload",
      ),
      reportsWorkspaceSource.indexOf("function registerDayPageTruth"),
    );
    const serverReport = insightsServerSource.slice(
      insightsServerSource.indexOf(
        "const RETURNS_EXCHANGES_REFUNDS_ACTIVITY_CTE",
      ),
      insightsServerSource.indexOf("pub struct DonationPaymentReportRow"),
    );

    expect(loader).toContain("dataset_truth");
    expect(loader).toContain("REGISTER_REPORT_OUTPUT_ROW_LIMIT");
    expect(loader).toContain("rowIds.has(rowId)");
    expect(loader).toContain("rows.length !== expectedTotal");
    expect(loader).toContain("Nothing was displayed or output");
    expect(reportsWorkspaceSource).toContain("Complete audited set:");
    expect(insightsServerSource).toContain(
      "RETURNS_REPORT_MAX_ROWS: i64 = 20_000",
    );
    expect(serverReport).toContain("REPEATABLE READ READ ONLY");
    expect(serverReport).toContain("STRING_AGG(ROW_TO_JSON(report_row)::text");
    expect(serverReport).toContain("ORDER BY activity_at DESC, row_id ASC");
    expect(serverReport).not.toContain("LIMIT 1000");
  });

  test("lane-scoped register reports require the matching POS secret or register.reports", () => {
    const handler = insightsServerSource.slice(
      insightsServerSource.indexOf("async fn register_day_activity_summary"),
      insightsServerSource.indexOf("pub struct RegisterSessionsQuery"),
    );

    expect(handler).toContain("require_pos_session_secret_or_permission");
    expect(handler).toContain("REGISTER_REPORTS");
    expect(handler).toContain("fetch_complete_register_day_summary_for_output");
    expect(handler).toContain("complete_output requires activity_offset=0");
    expect(handler).not.toContain("lifecycle_status = 'open'");
    expect(registerReportsSource).toContain(
      'permissionsLoaded && hasPermission("register.reports")',
    );
    expect(registerReportsSource).toContain(
      "if (sessionId && !canViewStorewideReports)",
    );
    expect(registerReportsSource).toContain(
      'params.set("register_session_id", sessionId)',
    );
  });

  test("archived Z-report pages and history are timed, cancellable, and failure-aware", () => {
    const archivedLoader = registerReportsSource.slice(
      registerReportsSource.indexOf("const fetchBookedSummaryForDate"),
      registerReportsSource.indexOf("const loadSummaries"),
    );
    const historyLoader = registerReportsSource.slice(
      registerReportsSource.indexOf("const buildZLogParams"),
      registerReportsSource.indexOf("const fetchOpenSessions"),
    );

    expect(archivedLoader).toContain(
      "archivedZReportRequestRef.current?.abort()",
    );
    expect(archivedLoader).toContain("fetchWithTimeout");
    expect(archivedLoader).toContain("signal: controller.signal");
    expect(archivedLoader).toContain("archived Z-report timed out");
    expect(historyLoader).toContain("String(Z_LOG_LIMIT)");
    expect(historyLoader).toContain("zLogsRequestRef.current?.abort()");
    expect(historyLoader).toContain("fetchWithTimeout");
    expect(historyLoader).toContain("setZLogsError");
    expect(registerReportsSource).toContain("Z-report history is unavailable.");
    expect(registerReportsSource).toContain(
      "Showing up to the newest {Z_LOG_LIMIT}",
    );
  });

  test("Z-reports keep operational issues out of financial output and show complete deposits", () => {
    expect(reportPrintSource).not.toContain("UNRESOLVED ISSUES AT CLOSE");
    expect(reportPrintSource).not.toContain("Unresolved Issues at Close");
    expect(reportPrintSource).not.toContain(
      "UNRESOLVED ISSUES CURRENTLY VISIBLE (PREVIEW)",
    );
    expect(reportPrintSource).toContain("Checks for Deposit");
    expect(reportPrintSource).toContain("Total Deposit");
    expect(reportPrintSource).toContain(
      '<tr><td>Checks Total</td><td class="center">',
    );
    expect(closeRegisterSource).toContain("recon?.check_payments");
    expect(closeRegisterSource).toContain("cashDepositCents + checkTotalCents");
    expect(sessionsServerSource).toContain(
      "pub check_payments: Vec<CheckPaymentLine>",
    );
    expect(sessionsServerSource).toContain("pt.id AS payment_transaction_id");
    expect(sessionsServerSource).toContain(
      "LOWER(TRIM(pt.payment_method)) IN ('check', 'cheque')",
    );
    expect(closeRegisterSource).toContain(
      "const closedReconciliation = result.reconciliation",
    );
    expect(closeRegisterSource).toContain(
      "const closedSnapshot = result.z_report_snapshot",
    );
    expect(closeRegisterSource).toMatch(
      /openCurrentZReportPrint\(\s+closedReconciliation/,
    );
    expect(closeRegisterSource).toContain("closedSnapshot?.day_summary ??");
    expect(closeRegisterSource).toContain("salesCount: daySummary.sales_count");
    expect(registerReportsSource).toContain("daySummary: RegisterDaySummary");
    expect(reportPrintSource).toContain("<h2>Quick Look</h2>");
    expect(reportPrintSource).not.toContain("includeSupplementalSummary");
    expect(reportPrintSource).not.toContain(
      "Supplemental business-day metrics are pending",
    );
    expect(closeRegisterSource).not.toContain(
      'openCurrentZReportPrint(\n        recon,\n        "print"',
    );

    const closeHandler = sessionsServerSource.slice(
      sessionsServerSource.indexOf("async fn close_session("),
      sessionsServerSource.indexOf(
        "async fn",
        sessionsServerSource.indexOf("async fn close_session(") + 1,
      ),
    );
    expect(closeHandler).toContain(
      '"unresolved_close_issues": unresolved_close_issues.as_ref()',
    );
    expect(closeHandler).toContain("'register_close_with_unresolved_issues'");
    const groupLock = closeHandler.indexOf("FOR UPDATE");
    const recoveryLock = closeHandler.indexOf("OPEN_RECOVERY_JOBS_SQL");
    const helcimLock = closeHandler.indexOf("UNRESOLVED_HELCIM_ATTEMPTS_SQL");
    const reconciliationRead = closeHandler.indexOf("build_reconciliation(");
    expect(groupLock).toBeGreaterThanOrEqual(0);
    expect(recoveryLock).toBeGreaterThan(groupLock);
    expect(helcimLock).toBeGreaterThan(recoveryLock);
    expect(reconciliationRead).toBeGreaterThan(helcimLock);
    expect(closeHandler).toContain("fetch_complete_register_day_summary");
    expect(closeHandler).toContain('"day_summary": quick_look_summary');
    expect(closeHandler).toContain(
      "Z-report Quick Look totals could not be finalized; the Register was not closed.",
    );
    expect(sessionsServerSource).toContain(
      "target.checkout_client_id IS DISTINCT FROM ppa.checkout_client_id",
    );
    expect(sessionsServerSource).toContain("ppa.checkout_client_id IS NULL");
    expect(sessionsServerSource).toContain("z_report_snapshot: z_snapshot");
  });

  test("Daily Sales and Z-Reports use the same payment-ledger tender totals", () => {
    expect(registerDayServerSource).toContain(
      "pub tenders: Vec<RegisterDayTender>",
    );
    expect(registerDayServerSource).toContain(
      "SUM(pt.amount)::numeric(14,2)::text AS total_amount",
    );
    expect(registerReportsSource).toContain("tenders: periodSummary.tenders");
    expect(registerReportsSource).toContain(
      "summaryBooked.tenders,\n                            isCreditCardTender",
    );
    expect(registerReportsSource).not.toContain(
      "activityCreditCardTotalCents(summaryBooked.activities)",
    );
    expect(registerReportsSource).toContain(
      "tenderTotalCents(summaryBooked.tenders, isRmsChargeTender)",
    );
    expect(registerDayServerSource).toContain(
      "NULLIF(oix.size_specs->>'original_unit_price', '')::numeric",
    );

    const dailyPrint = reportPrintSource.slice(
      reportPrintSource.indexOf(
        "export async function openProfessionalDailySalesPrint",
      ),
    );
    expect(dailyPrint).toContain("creditCardTenderTotalCents(summary.tenders)");
    expect(dailyPrint).toContain("creditCardTenderCount(summary.tenders)");
    expect(dailyPrint).toContain(
      "tenderTotalCents(\n    summary.tenders,\n    isRmsChargeTender",
    );
    expect(dailyPrint).not.toMatch(
      /const creditCardTotalCents = activities\.reduce/,
    );
    expect(dailyPrint).not.toMatch(
      /const rmsChargeTotalCents = activities\.reduce/,
    );
    expect(reportPrintSource).not.toContain(
      "creditCardTenderTotalCents(opts.tenders) ||",
    );
    expect(reportPrintSource).toContain(
      '${rows.length} activity ${rows.length === 1 ? "entry" : "entries"}',
    );

    const zReportFromSession = registerReportsSource.slice(
      registerReportsSource.indexOf("async function openZReportFromSession"),
      registerReportsSource.indexOf("function registerReportApiError"),
    );
    for (const [dailyField, zOption] of [
      ["sales_count", "salesCount"],
      ["sales_tax_total", "salesTaxTotal"],
      ["net_sales", "netSales"],
      ["shipping_total", "shippingTotal"],
      ["alterations_total", "alterationsTotal"],
      ["gift_card_load_count", "giftCardLoadCount"],
      ["gift_card_load_total", "giftCardLoadTotal"],
      ["cash_collected", "cashCollected"],
      ["deposits_collected", "depositsCollected"],
    ]) {
      expect(registerReportsSource).toContain(
        `${dailyField}: periodSummary.${dailyField}`,
      );
      expect(zReportFromSession).toContain(
        `${zOption}: daySummary.${dailyField}`,
      );
      expect(closeRegisterSource).toContain(
        `${zOption}: daySummary.${dailyField}`,
      );
    }
  });

  test("closed Z-report Quick Look totals are mandatory before close commits", () => {
    expect(closeRegisterSource).toContain("closedSnapshot?.day_summary ??");
    expect(closeRegisterSource).toContain(
      'params.set("complete_output", "true")',
    );
    expect(closeRegisterSource).toContain("salesCount: daySummary.sales_count");
    expect(registerReportsSource).toContain("daySummary: RegisterDaySummary");
    expect(reportPrintSource).toContain("<h2>Quick Look</h2>");
    expect(reportPrintSource).not.toContain("includeSupplementalSummary");
    expect(reportPrintSource).not.toContain(
      "Supplemental business-day metrics are pending",
    );

    const closeHandler = sessionsServerSource.slice(
      sessionsServerSource.indexOf("async fn close_session("),
      sessionsServerSource.indexOf(
        "async fn",
        sessionsServerSource.indexOf("async fn close_session(") + 1,
      ),
    );
    expect(closeHandler).toContain("fetch_complete_register_day_summary");
    expect(closeHandler).toContain('"day_summary": quick_look_summary');
    expect(closeHandler).toContain(
      "Z-report Quick Look totals could not be finalized; the Register was not closed.",
    );
  });

  test("Z-report business date is fixed by the Register open period", () => {
    const reconciliationHandler = sessionsServerSource.slice(
      sessionsServerSource.indexOf("async fn build_reconciliation("),
      sessionsServerSource.indexOf(
        "async fn",
        sessionsServerSource.indexOf("async fn build_reconciliation(") + 1,
      ),
    );
    expect(reconciliationHandler).toContain(
      "(opened_at AT TIME ZONE reporting.effective_store_timezone())::date",
    );
    expect(reconciliationHandler).toContain("z_report_business_dates(");
    expect(reconciliationHandler).toContain(
      "let open_period_scope = prior_business_day_closes == 0",
    );
    expect(reconciliationHandler).toContain("$3::boolean");
    expect(sessionsServerSource).toContain(
      "return vec![open_period_business_date]",
    );
    expect(sessionsServerSource).toContain(
      '"opened_at": &recon.open_period_started_at',
    );
    expect(reportPrintSource).toContain("Print Date/Time:");
    expect(reportPrintSource).toContain("Open Period Started:");
    expect(reportPrintSource).toContain("Open Period Closed:");
    expect(closeRegisterSource).toContain(
      "following morning does not change it to today.",
    );
  });

  test("the dashboard distinguishes a physical Register from its session sequence", () => {
    expect(registerDashboardSource).toContain(
      'Register #{registerLane ?? "?"}',
    );
    expect(registerDashboardSource).toContain("Session #${registerOrdinal}");
    expect(registerDashboardSource).not.toContain(
      'Register {registerOrdinal ?? "0"}',
    );
  });

  test("POS and Back Office retain their audience-specific operational dashboards", () => {
    expect(registerDashboardSource).toContain('title="Wedding Pulse"');
    expect(registerDashboardSource).toContain('title="Weather"');
    expect(registerDashboardSource).toContain("<SalesByHourSnapshotCard");
    expect(registerDashboardSource).toContain('title="Alterations"');
    expect(operationsHomeSource).toContain(
      "useState(true)",
    );
    expect(operationsHomeSource).toContain('title="What Changed Today"');
    expect(operationsHomeSource).toContain('title="What Needs Attention"');
  });
});
