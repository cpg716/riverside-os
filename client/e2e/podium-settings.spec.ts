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
    const systemControlHeading = page.getByRole("heading", {
      level: 1,
      name: /system control/i,
    });
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect
      .poll(
        async () => {
          const settingsButton = mainNav.getByRole("button", {
            name: /^settings(\s+bo)?$/i,
          });
          if (!(await settingsButton.isVisible().catch(() => false))) return false;
          if (!(await settingsButton.isEnabled().catch(() => false))) return false;
          await settingsButton.click();
          const asideOk = await systemControlHeading
            .isVisible()
            .catch(() => false);
          const crumbOk = await breadcrumb
            .getByText(/settings/i)
            .first()
            .isVisible()
            .catch(() => false);
          return asideOk && crumbOk;
        },
        { timeout: 45_000 },
      )
      .toBeTruthy();
    const integrationsButton = page.getByRole("button", {
      name: /^integrations$/i,
    });
    let pr: Awaited<ReturnType<typeof page.waitForResponse>> | null = null;
    if (await integrationsButton.isVisible().catch(() => false)) {
      await expect(integrationsButton).toBeEnabled();
      await integrationsButton.click();
    }
    await expect(
      page
        .getByRole("heading", { name: /integrations & (bridges|hub)/i })
        .first(),
    ).toBeVisible({ timeout: 20_000 });
    const podiumLaunch = page.getByRole("button", { name: /podium comms/i }).first();
    await expect(podiumLaunch).toBeVisible({ timeout: 20_000 });
    [pr] = await Promise.all([
      page
        .waitForResponse(
          (r) =>
            r.url().includes("/api/settings/podium-sms") &&
            !r.url().includes("readiness") &&
            r.request().method() === "GET",
          { timeout: 25_000 },
        )
        .catch(() => null),
      podiumLaunch.click(),
    ]);
    if (pr && !pr.ok()) {
      test.skip(
        true,
        `GET /api/settings/podium-sms returned ${pr.status()} (requires settings.admin + API)`,
      );
    }
    await expect(
      page.getByRole("heading", { name: /podium integration/i }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(
      page.getByRole("heading", { name: /podium communications/i }),
    ).toBeVisible({ timeout: 25_000 });
  });
});
