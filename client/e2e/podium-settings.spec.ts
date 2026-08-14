import { expect, test } from "@playwright/test";
import {
  e2eBackofficeStaffCode,
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300";
  return raw.replace(/\/$/, "");
}

let canaryStaffOk = false;

test.beforeAll(async ({ request }) => {
  const code = e2eBackofficeStaffCode();
  try {
    const res = await request.get(
      `${apiBase()}/api/staff/effective-permissions`,
      {
        headers: {
          "x-riverside-staff-code": code,
          "x-riverside-staff-pin": code,
        },
        timeout: 8000,
        failOnStatusCode: false,
      },
    );
    if (!res.ok()) return;
    const j = (await res.json()) as { permissions?: string[] };
    canaryStaffOk =
      Array.isArray(j.permissions) &&
      j.permissions.length > 0 &&
      j.permissions.includes("settings.admin");
  } catch {
    canaryStaffOk = false;
  }
});

test.beforeEach(() => {
  test.skip(
    !canaryStaffOk,
    `API not reachable or staff code ${e2eBackofficeStaffCode()} lacks settings.admin`,
  );
});

test.describe("Settings Podium integration", () => {
  test("Settings Hub opens Podium controls", async ({ page }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "settings");

    const settingsHub = page.getByTestId("settings-workspace-content");
    const categories = settingsHub.getByRole("navigation", {
      name: "Settings categories",
    });
    await categories
      .getByRole("button", { name: /^connected services/i })
      .click();
    const podiumButton = settingsHub.getByRole("button", {
      name: /^podium/i,
    });
    await expect(podiumButton).toBeVisible({ timeout: 20_000 });
    await expect(podiumButton).toBeEnabled();
    await podiumButton.click();
    await expect(
      page.getByRole("heading", { name: /^podium integration$/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page
      .getByText("Diagnostics and contact maintenance", { exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /^check health$/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: /reconcile contacts/i }),
    ).toBeVisible();
  });
});
