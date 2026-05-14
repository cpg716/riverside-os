import { expect, test } from "@playwright/test";

import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
  enterPosShell,
} from "./helpers/openPosRegister";

/**
 * Morning Compass coach: register dashboard + Operations morning home.
 * Requires back-office staff sign-in and an open POS session for the dashboard path.
 */
test.describe("Morning Compass coach", () => {
  test("shows coach on register dashboard when permissions allow", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);
    await enterPosShell(page);
    await ensurePosRegisterSessionOpen(page);
    await ensurePosSaleCashierSignedIn(page);

    const dashboardTab = page
      .getByRole("navigation", { name: "POS Navigation" })
      .getByRole("button", { name: /^dashboard$/i });
    await expect(dashboardTab).toBeVisible({ timeout: 15_000 });
    await expect(dashboardTab).toBeEnabled();
    await dashboardTab.click();

    await expect(
      page.getByRole("heading", { name: /priority feed/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: /wedding pulse/i }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("shows coach on Operations morning home when permissions allow", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInToBackOffice(page);

    const operationsButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^operations(\s+bo)?$/i });
    await expect(operationsButton).toBeVisible({ timeout: 15_000 });
    await operationsButton.click();
    await expect(
      page.getByRole("heading", { name: /operations overview/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: /action board/i }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("daily briefing ROSIE insight is button-triggered and uses structured facts", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const insightBodies: unknown[] = [];
    await page.route("**/api/help/rosie/v1/insight-summary", async (route) => {
      const body = route.request().postDataJSON() as {
        surface?: string;
        facts?: {
          bullets?: { id?: string; label?: string }[];
          metrics?: unknown[];
        };
      };
      insightBodies.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "available",
          bullets: [
            { text: "Pickup and alteration counts are visible.", source_fact_ids: ["fulfillment-summary"] },
            { text: "Inventory alerts are summarized from the card.", source_fact_ids: ["inventory-alerts"] },
            { text: "Staff follow-up load stays staff-facing.", source_fact_ids: ["staff-followup"] },
            { text: "This fourth bullet should not render.", source_fact_ids: ["morning-queue"] },
          ],
        }),
      });
    });

    await signInToBackOffice(page);
    const operationsButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^operations(\s+bo)?$/i });
    await expect(operationsButton).toBeVisible({ timeout: 15_000 });
    await operationsButton.click();

    const insight = page.getByTestId("rosie-insight-summary-daily_operational_briefing");
    await expect(insight).toBeVisible({ timeout: 20_000 });
    expect(insightBodies).toHaveLength(0);

    await insight.getByRole("button", { name: /today at riverside rosie insight/i }).click();
    await expect.poll(() => insightBodies.length).toBe(1);
    await expect(insight.locator("li")).toHaveCount(3, { timeout: 15_000 });
    expect(insightBodies).toHaveLength(1);
    expect(insightBodies[0]).toMatchObject({
      surface: "daily_operational_briefing",
      mode: "summary",
    });
    const request = insightBodies[0] as {
      facts?: { bullets?: { id?: string; label?: string }[]; metrics?: unknown[] };
    };
    expect(request.facts?.metrics ?? []).toHaveLength(0);
    expect(request.facts?.bullets?.every((fact) => fact.id && fact.label)).toBe(true);
  });

  test("daily briefing ROSIE insight returns to idle when ROSIE is slow", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    let insightRequests = 0;
    await page.route("**/api/help/rosie/v1/insight-summary", async (route) => {
      insightRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "available",
            bullets: [
              { text: "This late response should stay hidden.", source_fact_ids: ["late"] },
            ],
          }),
        });
      } catch {
        // The client is expected to abort optional insight requests before this returns.
      }
    });

    await signInToBackOffice(page);
    const operationsButton = page
      .getByRole("navigation", { name: "Main Navigation" })
      .getByRole("button", { name: /^operations(\s+bo)?$/i });
    await expect(operationsButton).toBeVisible({ timeout: 15_000 });
    await operationsButton.click();

    const insight = page.getByTestId("rosie-insight-summary-daily_operational_briefing");
    await expect(insight).toBeVisible({ timeout: 20_000 });
    const insightButton = insight.getByRole("button", { name: /today at riverside rosie insight/i });

    await insightButton.click();
    await expect(insightButton).toContainText("ROSIE insight", { timeout: 6_000 });
    await expect(insight.locator("li")).toHaveCount(0);
    expect(insightRequests).toBe(1);
  });
});
