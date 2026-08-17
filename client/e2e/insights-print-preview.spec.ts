import { expect, test } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

const reportTitle = "Booked Sales by Salesperson This Month";
const salespersonMember = "booked_transactions.salesperson";
const salesMember = "booked_transactions.gross_sales";
const reportSpec = {
  title: reportTitle,
  explanation: "Booked revenue grouped by salesperson for the current month.",
  dataset: "booked_transactions",
  measures: [salesMember],
  dimensions: [salespersonMember],
  time_dimension: {
    member: "booked_transactions.business_date",
    granularity: null,
    date_range: ["2026-08-01", "2026-08-31"],
  },
  filters: [],
  order: [{ member: salesMember, direction: "desc" }],
  limit: 100,
  visualization: {
    kind: "bar" as const,
    x_member: salespersonMember,
    y_members: [salesMember],
  },
};
const reportRows = [
  ["JERROD MINER", 36_545.3],
  ["Robyn Cretacci", 30_546.08],
  ["Tom Lanighan", 26_414.21],
  ["Tom Zotos", 17_912.21],
  ["Mark Skonecki", 1_863.77],
  [null, 150],
  ["Staff Admin", 16.93],
  ["Office", 16.93],
].map(([salesperson, sales]) => ({
  [salespersonMember]: salesperson,
  [salesMember]: sales,
}));
const reportResult = {
  history_id: "00000000-0000-0000-0000-000000000001",
  question: "Show booked sales by salesperson this month",
  spec: reportSpec,
  rows: reportRows,
  row_count: reportRows.length,
  member_labels: {
    [salespersonMember]: "Salesperson",
    [salesMember]: "Booked sales",
  },
  member_formats: {
    [salespersonMember]: "text",
    [salesMember]: "money",
  },
  generated_at: "2026-08-16T21:14:22.000Z",
  engine: "cube_core",
};

test("Insights print preview preserves the complete chart and table", async ({
  page,
}) => {
  await signInToBackOffice(page);

  await page.route("**/api/insights/reports/favorites", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  });
  await page.route("**/api/insights/reports/history**", async (route) => {
    const archived = new URL(route.request().url()).searchParams.get(
      "archived",
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        archived === "true"
          ? []
          : [
              {
                id: reportResult.history_id,
                question: reportResult.question,
                title: reportTitle,
                report_spec: reportSpec,
                row_count: reportRows.length,
                created_at: reportResult.generated_at,
                last_accessed_at: reportResult.generated_at,
                archived_at: null,
              },
            ],
      ),
    });
  });
  await page.route("**/api/insights/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "connected",
        message: "Reporting ready",
        cube_ready: true,
        planner_ready: true,
      }),
    });
  });
  await page.route("**/api/insights/reports/run", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reportResult),
    });
  });

  await openBackofficeSidebarTab(page, "dashboard");
  await expect(page.getByRole("heading", { name: /^insights$/i })).toBeVisible({
    timeout: 25_000,
  });
  await page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: reportTitle })
    .click();
  await expect(page.getByRole("heading", { name: reportTitle })).toBeVisible({
    timeout: 10_000,
  });
  await page
    .getByRole("button", { name: "Close report generation status" })
    .click();

  await page.evaluate(() => {
    window.open = () => {
      const frame = document.createElement("iframe");
      frame.dataset.testid = "insights-print-preview-test";
      frame.style.width = "1200px";
      frame.style.height = "800px";
      document.body.append(frame);
      if (!frame.contentWindow) return null;
      frame.contentWindow.print = () => undefined;
      return frame.contentWindow;
    };
  });
  await page.getByRole("button", { name: /print \/ pdf/i }).click();
  await expect(page.getByLabel("Include visual chart")).toBeChecked();
  await page.getByRole("button", { name: /open preview/i }).click();
  const preview = page.frameLocator(
    'iframe[data-testid="insights-print-preview-test"]',
  );

  const visual = preview.getByRole("img", { name: "Report visual summary" });
  await expect(visual).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect
    .poll(async () =>
      visual.evaluate((image: HTMLImageElement) => ({
        width: image.naturalWidth,
        height: image.naturalHeight,
      })),
    )
    .toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  const imageSize = await visual.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }));
  expect(imageSize.width).toBeGreaterThan(1000);
  expect(imageSize.height).toBeGreaterThan(200);
  await expect(preview.locator("tbody tr")).toHaveCount(reportRows.length);
  await expect(preview.locator("thead")).toContainText("BOOKED SALES");
  await expect(preview.locator("thead")).toContainText("SALESPERSON");
});
