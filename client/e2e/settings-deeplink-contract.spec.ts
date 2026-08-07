import { expect, test, type Page } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

type RouteCase = {
  label: string;
  route: string;
  expectedPanelSignals: RegExp[];
  allowedUrlPatterns: RegExp[];
};

const SETTINGS_ROUTE_CASES: RouteCase[] = [
  {
    label: "valid section route",
    route: "/settings/general",
    expectedPanelSignals: [/System Settings/i, /Settings Hub/i],
    allowedUrlPatterns: [/\/settings\/general\/?$/i, /\/settings\/?$/i],
  },
  {
    label: "unknown section route fallback",
    route: "/settings/unknown-section",
    expectedPanelSignals: [/System Settings/i, /Settings Hub/i, /Profile/i],
    allowedUrlPatterns: [
      /\/settings\/unknown-section\/?$/i,
      /\/settings\/general\/?$/i,
      /\/settings\/?$/i,
    ],
  },
  {
    label: "partial route normalization",
    route: "/settings//shippo",
    expectedPanelSignals: [/Shipping Configuration/i, /System Settings/i, /Settings Hub/i],
    allowedUrlPatterns: [
      /\/settings\/\/shippo\/?$/i,
      /\/settings\/shippo\/?$/i,
      /\/settings\/general\/?$/i,
      /\/settings\/?$/i,
    ],
  },
  {
    label: "root settings route",
    route: "/settings",
    expectedPanelSignals: [/Settings Hub/i, /System Settings/i, /Profile/i],
    allowedUrlPatterns: [/\/settings\/?$/i, /\/settings\/general\/?$/i],
  },
];

async function expectNoDeadShell(page: Page) {
  await expect(
    page.getByRole("navigation", { name: "Main Navigation" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("settings-workspace-content")).toBeVisible({
    timeout: 20_000,
  });
}

async function expectAtLeastOneSignal(page: Page, signals: RegExp[]) {
  for (const signal of signals) {
    const locator = page.getByText(signal).first();
    if (await locator.isVisible().catch(() => false)) {
      return;
    }
  }
  throw new Error(`None of the expected settings panel signals were visible: ${signals.map((s) => s.source).join(", ")}`);
}

test.describe("settings deep-link contract", () => {
  test("URL routes keep Settings visible and normalize safely", async ({ page }) => {
    test.setTimeout(120_000);
    await signInToBackOffice(page, { persistSession: true });

    for (const routeCase of SETTINGS_ROUTE_CASES) {
      await page.goto(routeCase.route, { waitUntil: "domcontentloaded" });
      await expectNoDeadShell(page);
      await expectAtLeastOneSignal(page, routeCase.expectedPanelSignals);

      const finalPath = new URL(page.url()).pathname;
      const urlOk = routeCase.allowedUrlPatterns.some((pattern) =>
        pattern.test(finalPath),
      );
      expect(
        urlOk,
        `${routeCase.label}: final URL ${finalPath} did not match allowed patterns ${routeCase.allowedUrlPatterns.map((r) => r.source).join(", ")}`,
      ).toBe(true);
    }
  });

  test("printer settings keep Reports printer on installed-printer path", async ({ page }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page, { persistSession: true });

    await page.goto("/settings/printing", { waitUntil: "domcontentloaded" });
    await expectNoDeadShell(page);

    const reportCard = page.getByTestId("printer-card-report");
    await expect(reportCard).toContainText("Reports Printer");
    await expect(reportCard.getByLabel("Printer setup")).toHaveValue("system");
    await expect(reportCard.getByRole("option", { name: "Network address" })).toHaveCount(0);
    await expect(reportCard.getByRole("button", { name: /Check connection/i })).toBeVisible();

    const tagCard = page.getByTestId("printer-card-tag");
    await expect(tagCard).toContainText("Clothing Tag Station");
    await expect(tagCard).toContainText("Zebra LP 2844");
    await expect(tagCard).toContainText("Suggested Windows queue: Zebra LP 2844");
    await expect(tagCard).toContainText("Production tags use EPL2");
    await expect(tagCard.getByLabel("Printer setup")).toHaveValue("system");
    await expect(tagCard.locator("select").nth(1)).toBeVisible();
    await expect(tagCard.getByLabel("Tag Printer Mode")).toHaveCount(0);
    await expect(tagCard.getByLabel("Tag Printer Language")).toHaveCount(0);
    await expect(page.getByText("Printer Diagnostics")).toBeVisible();
    await expect(page.getByText("Tag language")).toBeVisible();
    await expect(page.getByText("EPL2", { exact: true })).toBeVisible();
    await expect(page.getByText("Last test result:")).toBeVisible();
  });
});
