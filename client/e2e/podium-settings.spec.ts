import { expect, test } from "@playwright/test";
import {
  e2eBackofficeStaffCode,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

function apiBase(): string {
  const raw =
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:3000";
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
  test("Integrations tab shows Podium section", async ({ page }) => {
    test.setTimeout(90_000);
    await signInToBackOffice(page);
    const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
    await expect(mainNav).toBeVisible({ timeout: 20_000 });
    const settingsButton = mainNav.getByRole("button", {
      name: /^settings(\s+bo)?$/i,
    });
    await expect(settingsButton).toBeVisible({ timeout: 15_000 });
    await expect(settingsButton).toBeEnabled();
    await settingsButton.click();

    const integrationsButton = mainNav.getByRole("button", {
      name: /^integrations$/i,
    });
    await expect(integrationsButton).toBeVisible({ timeout: 15_000 });
    await expect(integrationsButton).toBeEnabled();
    await integrationsButton.click();
    await expect(
      page
        .getByRole("heading", { name: /integrations & (bridges|hub)/i })
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    await expect(
      page.getByRole("heading", { level: 3, name: /podium comms/i }).first(),
    ).toBeVisible({ timeout: 25_000 });
    await expect(
      page.getByText(/lifecycle sms & html email/i).first(),
    ).toBeVisible({ timeout: 25_000 });
  });
});
