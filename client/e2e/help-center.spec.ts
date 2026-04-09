/**
 * Smoke: Help slideout from Back Office header and POS top bar.
 *
 *   cd client && E2E_BASE_URL=http://localhost:5173 npm run test:e2e -- e2e/help-center.spec.ts
 */
import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

const base = () => (process.env.E2E_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");

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

test("help search lists Results after query (Meilisearch or local fallback)", async ({ page }) => {
  await signInToBackOffice(page);
  await page.goto(base(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("help-center-trigger").click();
  await page.getByTestId("help-center-search").fill("checkout");
  await expect(page.getByText("Results").first()).toBeVisible({ timeout: 15_000 });
});
