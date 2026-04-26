import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";

type SchedulerViewport = {
  label: string;
  width: number;
  height: number;
};

const SCHEDULER_VIEWPORTS: SchedulerViewport[] = [
  { label: "phone_390x844", width: 390, height: 844 },
  { label: "tablet_768x1024", width: 768, height: 1024 },
  { label: "ipad_1024x1366", width: 1024, height: 1366 },
  { label: "desktop_1440x900", width: 1440, height: 900 },
];

for (const viewport of SCHEDULER_VIEWPORTS) {
  test(`Scheduler mobile ergonomics ${viewport.label}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInToBackOffice(page);

    await page.route("**/api/weddings/appointments/search?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "appt-1",
            datetime: "2026-04-26T10:00:00",
            customerName: "Alex Rivera",
            customer_display_name: "Alex Rivera",
            appointment_type: "fitting",
          },
        ]),
      });
    });

    await openBackofficeSidebarTab(page, "appointments");
    await expect(page.getByRole("heading", { name: /appointment schedule/i })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: /^week$/i }).click();
    await expect(page.getByTestId("scheduler-week-grid-shell")).toBeVisible({ timeout: 15_000 });

    const timeCellWidth = await page
      .getByTestId("scheduler-week-time-cell")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    if (viewport.width <= 639) {
      expect(timeCellWidth).toBeLessThan(95);
    } else {
      expect(timeCellWidth).toBeGreaterThan(90);
    }

    await page.getByTestId("scheduler-search-input").fill("alex");
    await expect(page.getByTestId("scheduler-search-popover")).toBeVisible({ timeout: 15_000 });
    const popoverWidth = await page
      .getByTestId("scheduler-search-popover")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(popoverWidth).toBeLessThanOrEqual(viewport.width * 0.97 + 6);
    await page.keyboard.press("Escape").catch(() => {});
    await page.getByTestId("scheduler-search-input").fill("");
    await expect(page.getByTestId("scheduler-search-popover")).toHaveCount(0);

    await page.getByRole("button", { name: /new appt/i }).click();
    await expect(page.getByTestId("appointment-modal")).toBeVisible({ timeout: 15_000 });
    const submitButton = page.getByTestId("appointment-modal-submit");
    await expect(submitButton).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("appointment-modal-cancel").click();
    await expect(page.getByTestId("appointment-modal")).toHaveCount(0);
  });
}
