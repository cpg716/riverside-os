import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

const SENSITIVE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyaXZlcnNpZGUtc3RhZmYifQ.sensitiveSignature";
const SENSITIVE_COOKIE = "ros_session=very-secret-cookie";
const SENSITIVE_SECRET = "secret-value-123";
const REDACTED = "[redacted]";

async function openSettingsSubItem(page: Page, label: RegExp): Promise<void> {
  const menuToggle = page.getByRole("button", { name: /toggle menu/i });
  if (await menuToggle.isVisible().catch(() => false)) {
    await menuToggle.click().catch(() => {});
  }
  const subButton = page.getByRole("button", { name: label }).first();
  await expect(subButton).toBeVisible({ timeout: 20_000 });
  await subButton.click({ force: true });
}

function expectNoSecrets(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  expect(text).not.toContain(SENSITIVE_JWT);
  expect(text).not.toContain(SENSITIVE_COOKIE);
  expect(text).not.toContain(SENSITIVE_SECRET);
  expect(text).not.toMatch(/Bearer\s+eyJ/i);
  expect(text).toContain(REDACTED);
}

test.describe("bug reporting diagnostics hardening", () => {
  test("manual bug reports redact diagnostic secrets before submit", async ({
    page,
  }) => {
    let submittedBody: unknown = null;
    await page.route("**/api/bug-reports", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      submittedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "bug-1",
          correlation_id: "11111111-2222-4333-8444-555555555555",
        }),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await page.evaluate(
      ({ jwt, cookie, secret }) => {
        console.error(
          `Authorization: Bearer ${jwt}; cookie=${cookie}; staff_pin=1234`,
          {
            api_key: secret,
            password: secret,
            session_id: "session-secret-456",
            nested: { token: jwt },
          },
        );
      },
      {
        jwt: SENSITIVE_JWT,
        cookie: SENSITIVE_COOKIE,
        secret: SENSITIVE_SECRET,
      },
    );

    await page.getByTestId("bug-report-trigger").click();
    await expect(page.getByLabel(/what went wrong/i)).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByLabel(/what went wrong/i)
      .fill(`Customer screen failed with token=${SENSITIVE_SECRET}`);
    await page
      .getByLabel(/what were you doing/i)
      .fill(`Opened profile after Authorization: Bearer ${SENSITIVE_JWT}`);
    await page.getByRole("button", { name: /^submit report$/i }).click();

    await expect
      .poll(() => submittedBody, {
        timeout: 20_000,
        message: "bug report payload was not submitted",
      })
      .not.toBeNull();
    expectNoSecrets(submittedBody);
    const body = submittedBody as Record<string, unknown>;
    expect(body.client_meta).toEqual(
      expect.objectContaining({
        event_capture: expect.objectContaining({
          capture_type: "manual_bug_report",
        }),
      }),
    );
  });

  test("bug report detail downloads redact stored browser diagnostics", async ({
    page,
  }) => {
    await page.route(/\/api\/settings\/bug-reports$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "report-1",
            correlation_id: "22222222-3333-4444-8555-666666666666",
            created_at: "2026-05-09T12:00:00Z",
            status: "pending",
            summary: "Checkout froze",
            staff_id: "staff-1",
            staff_name: "Chris G",
          },
        ]),
      });
    });
    await page.route(/\/api\/settings\/bug-reports\/error-events$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/settings/bug-reports/report-1", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "report-1",
          correlation_id: "22222222-3333-4444-8555-666666666666",
          created_at: "2026-05-09T12:00:00Z",
          updated_at: "2026-05-09T12:00:00Z",
          status: "pending",
          summary: "Checkout froze",
          steps_context: `Used cookie=${SENSITIVE_COOKIE}`,
          client_console_log: `Authorization: Bearer ${SENSITIVE_JWT}\nsecret=${SENSITIVE_SECRET}`,
          client_meta: {
            href: "/settings?auth=visible",
            event_capture: {
              route: "/settings",
              token: SENSITIVE_JWT,
            },
          },
          screenshot_png_base64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          server_log_snapshot: `cookie: ${SENSITIVE_COOKIE}\napi_key=${SENSITIVE_SECRET}`,
          resolver_notes: "",
          external_url: "",
          staff_id: "staff-1",
          staff_name: "Chris G",
          resolved_at: null,
          resolver_name: null,
        }),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "settings");
    await openSettingsSubItem(page, /^bug reports$/i);
    await page.getByRole("button", { name: /^view$/i }).click();
    await expect(page.getByRole("dialog", { name: /bug report detail/i })).toBeVisible({
      timeout: 20_000,
    });

    const jsonDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /ai diagnostic json/i }).click();
    const jsonDownload = await jsonDownloadPromise;
    const jsonPath = await jsonDownload.path();
    expect(jsonPath).toBeTruthy();
    expectNoSecrets(await readFile(jsonPath!, "utf8"));

    const browserLogDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /browser log/i }).click();
    const browserLogDownload = await browserLogDownloadPromise;
    const browserLogPath = await browserLogDownload.path();
    expect(browserLogPath).toBeTruthy();
    expectNoSecrets(await readFile(browserLogPath!, "utf8"));
  });

  test("error toast events are redacted, contextual, and deduped", async ({
    page,
  }) => {
    const errorEventPayloads: unknown[] = [];
    await page.route("**/api/bug-reports/error-events", async (route) => {
      errorEventPayloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "event-1" }),
      });
    });
    await page.route(/\/api\/settings\/bug-reports$/, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: `Could not load Authorization: Bearer ${SENSITIVE_JWT}; cookie=${SENSITIVE_COOKIE}`,
        }),
      });
    });
    await page.route(/\/api\/settings\/bug-reports\/error-events$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "settings");
    await openSettingsSubItem(page, /^bug reports$/i);

    await expect
      .poll(() => errorEventPayloads.length, {
        timeout: 20_000,
        message: "toast error event was not submitted",
      })
      .toBe(1);
    await page.getByRole("button", { name: /^refresh$/i }).click();
    await expect.poll(() => errorEventPayloads.length, { timeout: 2_000 }).toBe(1);

    const payload = errorEventPayloads[0] as Record<string, unknown>;
    expectNoSecrets(payload);
    expect(payload).toEqual(
      expect.objectContaining({
        event_source: "client_toast",
        severity: "error",
        route: expect.any(String),
      }),
    );
    expect(payload.client_meta).toEqual(
      expect.objectContaining({
        event_capture: expect.objectContaining({
          route: expect.any(String),
          toast_source: "client",
        }),
      }),
    );
  });

  test("server error events surface in bug report triage", async ({ page }) => {
    await page.route(/\/api\/settings\/bug-reports$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route(/\/api\/settings\/bug-reports\/error-events$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "server-event-1",
            created_at: "2026-05-19T13:00:00Z",
            staff_id: null,
            staff_name: null,
            status: "pending",
            message: "Runtime diagnostics failed to load on the server",
            event_source: "server_api_error",
            severity: "error",
            route: "/api/ops/runtime-diagnostics",
            client_meta: {
              source: "server_api_error",
              server_dedupe_key:
                "server_api_error:/api/ops/runtime-diagnostics",
            },
            server_log_snapshot: "ops runtime diagnostics failed",
          },
        ]),
      });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "settings");
    await openSettingsSubItem(page, /^bug reports$/i);
    await page.getByRole("button", { name: /error events/i }).click();

    await expect(page.getByText("Server runtime")).toBeVisible();
    await expect(page.getByText("server api error")).toBeVisible();
    await expect(
      page.getByText("Runtime diagnostics failed to load on the server"),
    ).toBeVisible();
    await page.getByRole("button", { name: /^view$/i }).click();
    await page.getByText("Advanced details").click();
    await expect(page.getByText("ops runtime diagnostics failed")).toBeVisible();
  });

  test("Support Center keeps useful diagnostics visible when one feed fails", async ({
    page,
  }) => {
    await page.route("**/api/ops/overview", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          server_time: "2026-05-09T12:00:00Z",
          db_ok: true,
          meilisearch_configured: true,
          tailscale_expected: true,
          integrations: [],
          open_alerts: 1,
          stations_online: 2,
          stations_offline: 1,
          stations_stale: 1,
          pending_bug_reports: 1,
        }),
      });
    });
    await page.route("**/api/ops/runtime-diagnostics", async (route) => {
      await route.fulfill({ status: 503, body: "unavailable" });
    });
    await page.route("**/api/ops/stations", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            station_key: "station-online",
            station_label: "Register 1",
            app_version: "0.60.1",
            git_sha: "58088e9f",
            tailscale_node: null,
            lan_ip: "127.0.0.1",
            last_sync_at: null,
            last_update_check_at: null,
            last_update_install_at: null,
            last_seen_at: "2026-05-19T13:55:00Z",
            updated_at: "2026-05-19T13:55:00Z",
            online: true,
            station_lifecycle: "online",
            actionable: true,
          },
          {
            station_key: "station-actionable-offline",
            station_label: "Register 2",
            app_version: "0.60.1",
            git_sha: "58088e9f",
            tailscale_node: null,
            lan_ip: "127.0.0.2",
            last_sync_at: null,
            last_update_check_at: null,
            last_update_install_at: null,
            last_seen_at: "2026-05-19T12:55:00Z",
            updated_at: "2026-05-19T12:55:00Z",
            online: false,
            station_lifecycle: "recently_offline",
            actionable: true,
          },
          {
            station_key: "station-stale",
            station_label: "Old Register",
            app_version: "0.50.0",
            git_sha: "0a93200d",
            tailscale_node: null,
            lan_ip: "127.0.0.3",
            last_sync_at: null,
            last_update_check_at: null,
            last_update_install_at: null,
            last_seen_at: "2026-04-24T12:55:00Z",
            updated_at: "2026-04-24T12:55:00Z",
            online: false,
            station_lifecycle: "stale",
            actionable: false,
          },
        ]),
      });
    });
    await page.route("**/api/ops/alerts", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/ops/audit-log", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/ops/bugs/overview", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/ops/e2e-health", async (route) => {
      await route.fulfill({ status: 503, body: "unavailable" });
    });

    await signInToBackOffice(page, { persistSession: true });
    await openBackofficeSidebarTab(page, "settings");
    await openSettingsSubItem(page, /^ros dev center$/i);

    await expect(page.getByRole("heading", { name: /support center/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Partial Visibility")).toBeVisible();
    await expect(page.getByText("Runtime details could not refresh")).toBeVisible();
    await expect(page.getByText("Station Fleet")).toBeVisible();
    await expect(page.getByText("1 actionable offline")).toBeVisible();
    await expect(page.getByText("1 stale hidden from active triage.")).toBeVisible();
    await expect(page.getByText("Actionable Offline", { exact: true })).toBeVisible();
    await expect(page.getByText("Stale History")).toHaveCount(0);
    await page.getByRole("button", { name: "Show Stale" }).click();
    await expect(page.getByText("Stale History")).toBeVisible();
    await expect(page.getByText("Bug Manager (Source of Truth)")).toBeVisible();
  });
});
