import { expect, test } from "@playwright/test";
import {
  ensureSessionAuth,
  openCustomersRmsWorkspace,
  resetOpenRegisterSessions,
} from "./helpers/rmsCharge";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("RMS permissions split", () => {
  test("standard POS user stays limited to slim POS-safe RMS access", async ({ page, request }) => {
    await resetOpenRegisterSessions(request);
    const { sessionId, sessionToken } = await ensureSessionAuth(request, "5678");

    await signInToBackOffice(page, {
      staffCode: "5678",
      staffName: "E2E Non-Admin",
      persistSession: true,
    });
    await page.evaluate(
      ({ seededSessionId, seededSessionToken }) => {
        sessionStorage.setItem(
          "ros.posRegisterAuth.v1",
          JSON.stringify({ sessionId: seededSessionId, token: seededSessionToken }),
        );
      },
      {
        seededSessionId: sessionId,
        seededSessionToken: sessionToken,
      },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect
      .poll(
        async () => await page.locator("body").textContent(),
        { timeout: 20_000, message: "POS shell never adopted the non-admin RMS test identity." },
      )
      .toContain("E2E Non-Admin");

    const posNav = page.getByRole("navigation", { name: "POS Navigation" });
    await expect(posNav).toBeVisible({ timeout: 20_000 });
    await posNav.getByRole("button", { name: /^Customers$/i }).click({ force: true });
    await expect(page.getByText(/E2E Non-Admin/i).first()).toBeVisible();
    await expect(posNav.getByRole("button", { name: /^QBO Bridge$/i })).toHaveCount(0);
    await expect(posNav.getByRole("button", { name: /^Settings$/i })).toHaveCount(0);
    await expect(page.getByText(/Run Reconciliation/i)).toHaveCount(0);
    await expect(page.getByText(/Exception Queue/i)).toHaveCount(0);
  });

  test("back office admin sees full RMS workspace capabilities", async ({ page, request }) => {
    await resetOpenRegisterSessions(request);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      sessionStorage.removeItem("ros.backoffice.session.v1");
      sessionStorage.removeItem("ros.posRegisterAuth.v1");
    });
    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await expect(page.getByTestId("rms-workspace-tab-overview")).toBeVisible();
    await page.getByTestId("rms-workspace-tab-reconciliation").click();
    await expect(page.getByTestId("rms-run-reconciliation")).toBeVisible();
    await page.getByTestId("rms-workspace-tab-exceptions").click();
    await expect(page.getByText(/No active RMS Charge exceptions|Loading open issues/i)).toBeVisible();
  });
});
