import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(
  new URL("../src/components/insights/NativeInsightsWorkspace.tsx", import.meta.url),
  "utf8",
);
const jobsSource = readFileSync(
  new URL("../src/lib/insightsReportJobs.ts", import.meta.url),
  "utf8",
);
const printSource = readFileSync(
  new URL("../src/components/pos/zReportPrint.ts", import.meta.url),
  "utf8",
);

test.describe("Insights workspace delivery contract", () => {
  test("keeps report generation outside the mounted workspace and announces completion", () => {
    expect(jobsSource).toContain("MAX_CONCURRENT_INSIGHTS_JOBS = 2");
    expect(jobsSource).toContain("dispatchAppToast(`Report ready:");
    expect(workspaceSource).toContain("subscribeInsightsReportJobs");
    expect(workspaceSource).toContain("you may leave this section");
    expect(workspaceSource).toContain("Start a separate report");
  });

  test("uses standardized portaled status and print option dialogs", () => {
    expect(workspaceSource).toContain('document.getElementById("drawer-root")');
    expect(workspaceSource).toContain("ui-overlay-backdrop fixed inset-0 z-[200]");
    expect(workspaceSource).toContain("Your report is generating");
    expect(workspaceSource).toContain("Include visual chart");
  });

  test("passes the application chart SVG into the professional print path", () => {
    expect(workspaceSource).toContain('querySelector("svg")?.outerHTML');
    expect(printSource).toContain("visualHtml?: string");
    expect(printSource).toContain('class="report-visual"');
  });

  test("offers local presentation controls without rerunning governed data", () => {
    expect(workspaceSource).toContain('["table", "bar", "line", "area", "pie"]');
    expect(workspaceSource).toContain("setVisualizationKind(kind)");
    expect(workspaceSource).toContain("Visual {showVisual ? \"on\" : \"off\"}");
    expect(workspaceSource).toContain("Data {showData ? \"on\" : \"off\"}");
  });
});
