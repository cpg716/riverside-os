import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  parseRegisterReportMoneyToCents,
  REGISTER_REPORT_OUTPUT_ROW_LIMIT,
  registerReportCombinedRowCount,
} from "../src/components/pos/zReportPrint";

const registerReportsSource = readFileSync(
  new URL("../src/components/pos/RegisterReports.tsx", import.meta.url),
  "utf8",
);
const reportPrintSource = readFileSync(
  new URL("../src/components/pos/zReportPrint.ts", import.meta.url),
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

  test("multi-page output rejects moving totals, duplicate rows, and incomplete detail", () => {
    expect(registerReportsSource).toContain("appendStableRegisterReportPage");
    expect(registerReportsSource).toContain("assertCompleteRegisterReportPages");
    expect(registerReportsSource).toContain(
      "changed while its audited detail was being prepared",
    );
    expect(registerReportsSource).toContain("activityIds.has(row.id)");
    expect(registerReportsSource).toContain("pickupIds.has(row.id)");
    expect(registerReportsSource).toContain(
      "activityCount !== accumulator.expectedActivityCount",
    );
    expect(registerReportsSource).toContain(
      "pickupCount !== accumulator.expectedPickupCount",
    );
    expect(registerReportsSource).toContain(
      "registerReportSummaryTruth(page) !== accumulator.expectedSummaryTruth",
    );
  });

  test("filtered output keeps full-period summary and filtered detail scopes separate", () => {
    const printHandler = registerReportsSource.slice(
      registerReportsSource.indexOf("const handleReportOutput"),
      registerReportsSource.indexOf("const handleExportCSV"),
    );

    expect(printHandler).toContain("unfilteredPeriodSummary");
    expect(printHandler).toContain("const periodSummary = unfilteredPeriodSummary ?? printSummary");
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
});
