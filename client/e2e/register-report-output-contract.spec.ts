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
const insightsServerSource = readFileSync(
  new URL("../../server/src/api/insights.rs", import.meta.url),
  "utf8",
);
const registerDayServerSource = readFileSync(
  new URL("../../server/src/logic/register_day_activity.rs", import.meta.url),
  "utf8",
);
const sessionsServerSource = readFileSync(
  new URL("../../server/src/api/sessions.rs", import.meta.url),
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

    expect(additionalMetrics).toContain(
      'summaryBooked ? summaryBooked.special_order_sale_count : "—"',
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

  test("immediate and archived Z-reports print immutable unresolved close issues", () => {
    expect(reportPrintSource).toContain("UNRESOLVED ISSUES AT CLOSE");
    expect(reportPrintSource).toContain("Unresolved Issues at Close");
    expect(reportPrintSource).toContain(
      "UNRESOLVED ISSUES CURRENTLY VISIBLE (PREVIEW)",
    );
    expect(reportPrintSource).toContain(
      "These items are unresolved in this pre-close preview.",
    );
    expect(reportPrintSource).toContain(
      "Closing did not resolve or dismiss them.",
    );
    expect(reportPrintSource).toContain("unresolvedRecoveryKeys");
    expect(reportPrintSource).toContain("unresolvedRecoveryJobs");
    expect(reportPrintSource).toContain("unresolvedStationWarnings");
    expect(reportPrintSource).toContain("unresolvedHelcimAttempts");
    expect(registerReportsSource).toContain(
      "unresolvedCloseIssues: snapshot?.unresolved_close_issues ?? null",
    );
    expect(registerReportsSource).toContain(
      'unresolvedIssuesContext: "closed"',
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
    expect(closeRegisterSource).toContain(
      "closedSnapshot?.unresolved_close_issues ?? null",
    );
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
    expect(sessionsServerSource).toContain(
      "AND ppa.checkout_client_id IS NOT NULL",
    );
    expect(sessionsServerSource).toContain("z_report_snapshot: z_snapshot");
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
    expect(reconciliationHandler).toContain(
      "$3::boolean",
    );
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
});
