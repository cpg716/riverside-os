/**
 * Smoke + manager coverage: Help slideout from Back Office/POS and
 * Help Center Manager settings workflows (navigation + admin ops calls).
 *
 * Run:
 *   cd client
 *   E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npm run test:e2e -- e2e/help-center.spec.ts --workers=1
 */
import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

const base = () =>
  (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");

async function openSettingsHelpCenterManager(
  page: Parameters<typeof test>[0]["page"],
) {
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
  await expect(mainNav).toBeVisible({ timeout: 20_000 });

  const settingsBtn = mainNav.getByRole("button", {
    name: /^settings(\s+bo)?$/i,
  });
  await expect(settingsBtn).toBeVisible({ timeout: 15_000 });
  await expect(settingsBtn).toBeEnabled();
  await settingsBtn.click();

  const systemControlHeading = page.getByRole("heading", {
    level: 1,
    name: /system control/i,
  });
  await expect(systemControlHeading).toBeVisible({ timeout: 20_000 });

  const settingsAside = page.locator("aside").filter({
    has: page.getByRole("heading", { level: 1, name: /system control/i }),
  });

  const helpCenterManagerButton = settingsAside.getByRole("button", {
    name: /help center manager/i,
  });
  await expect(helpCenterManagerButton).toBeVisible({ timeout: 15_000 });
  await expect(helpCenterManagerButton).toBeEnabled();
  await helpCenterManagerButton.click();

  await expect(
    page.getByRole("heading", { name: /help center manager/i }),
  ).toBeVisible({ timeout: 20_000 });
}

test("opens Help from Back Office header", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto(base(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await expect(page.getByRole("dialog", { name: /help/i })).toBeVisible();
  await expect(page.getByTestId("help-center-search")).toBeVisible();
  await expect(page.getByPlaceholder("Search manuals…")).toBeVisible();
});

test("opens Help from POS top bar", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto(`${base()}/pos`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await expect(page.getByRole("dialog", { name: /help/i })).toBeVisible();
  await expect(page.getByTestId("help-center-search")).toBeVisible();
});

test("help search lists Results after query (Meilisearch or local fallback)", async ({
  page,
}) => {
  await signInToBackOffice(page);
  await page.goto(base(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-search").fill("checkout");
  await expect(page.getByText("Results").first()).toBeVisible({
    timeout: 15_000,
  });
});

test.describe("Help Center Manager (settings)", () => {
  test("navigates to Help Center Manager and shows key tabs", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    await openSettingsHelpCenterManager(page);

    const managerPanel = page.locator("main, section, div").filter({
      has: page.getByRole("heading", { name: /help center manager/i }),
    }).first();
    await expect(
      managerPanel.getByRole("button", { name: /library/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /editor/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /automation/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /search & index/i }).first(),
    ).toBeVisible();
    await expect(
      managerPanel.getByRole("button", { name: /rosie readiness/i }).first(),
    ).toBeVisible();
  });

  test("automation tab triggers generate-manifest admin op request", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    await openSettingsHelpCenterManager(page);

    await page.getByRole("button", { name: /automation/i }).click();

    const reqPromise = page.waitForRequest(
      (r) =>
        r.url().includes("/api/help/admin/ops/generate-manifest") &&
        r.method() === "POST",
      { timeout: 20_000 },
    );

    await page
      .getByRole("button", { name: /run help manifest workflow/i })
      .click();

    const req = await reqPromise;
    const body = req.postDataJSON() as {
      dry_run?: boolean;
      include_shadcn?: boolean;
      rescan_components?: boolean;
      cleanup_orphans?: boolean;
    };

    expect(typeof body).toBe("object");
    expect(typeof body.dry_run).toBe("boolean");
    expect(typeof body.include_shadcn).toBe("boolean");
    expect(typeof body.rescan_components).toBe("boolean");
    expect(typeof body.cleanup_orphans).toBe("boolean");
  });

  test("search & index tab triggers reindex-search admin op request", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    await openSettingsHelpCenterManager(page);

    await page.getByRole("button", { name: /search & index/i }).click();

    const reqPromise = page.waitForRequest(
      (r) =>
        r.url().includes("/api/help/admin/ops/reindex-search") &&
        r.method() === "POST",
      { timeout: 20_000 },
    );

    await page.getByRole("button", { name: /reindex help search/i }).click();

    const req = await reqPromise;
    const body = req.postDataJSON() as {
      full_reindex_fallback?: boolean;
    };

    expect(typeof body).toBe("object");
    expect(typeof body.full_reindex_fallback).toBe("boolean");
  });
});
