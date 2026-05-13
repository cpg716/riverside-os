import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("ROS Operations Center", () => {
  test("summarizes blockers, degraded sources, safe actions, and deep links", async ({ page }) => {
    await page.route("**/api/ops/health/snapshot", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          db_ok: true,
          open_alerts: 2,
          stations_online: 1,
          stations_offline: 1,
          pending_bug_reports: 1,
          integrations: [
            {
              key: "counterpoint_sync",
              title: "Counterpoint sync",
              status: "degraded",
              severity: "warning",
              detail: "inventory (stale)",
              last_success_at: "2026-05-13T12:00:00Z",
              last_failure_at: null,
            },
          ],
        }),
      });
    });
    await page.route("**/api/transactions/fulfillment-queue", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { urgency: "blocked", balance_due: 0 },
          { urgency: "ready", balance_due: 0 },
          { urgency: "rush", balance_due: 20 },
        ]),
      });
    });
    await page.route("**/api/notifications/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          summary: {
            unread_rows: 4,
            stale_unread_rows: 2,
            active_inbox_rows: 4,
            canonical_notifications_24h: 8,
          },
          generator_runs: [
            {
              generator_key: "inventory_alerts",
              last_status: "failed",
              consecutive_failures: 2,
              last_error: "Inventory alert generator failed",
              last_finished_at: "2026-05-13T12:00:00Z",
            },
          ],
        }),
      });
    });
    await page.route("**/api/settings/counterpoint-sync/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          windows_sync_state: "degraded",
          counterpoint_staging_enabled: true,
          staging_pending_count: 1,
          staging_applying_count: 1,
          recent_issues: [
            {
              id: "cp-issue-1",
              entity: "inventory",
              severity: "error",
              message: "Inventory sync stale",
              created_at: "2026-05-13T12:00:00Z",
            },
          ],
          entity_runs: [
            {
              entity: "inventory",
              last_ok_at: "2026-05-13T11:30:00Z",
              last_error: "Bridge unreachable",
            },
          ],
        }),
      });
    });
    await page.route("**/api/customers/rms-charge/reconciliation?limit=10", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "rms-1",
              severity: "critical",
              status: "open",
              mismatch_type: "posting_status_mismatch",
              created_at: "2026-05-13T12:05:00Z",
            },
          ],
          runs: [
            {
              status: "completed",
              started_at: "2026-05-13T12:00:00Z",
              completed_at: "2026-05-13T12:01:00Z",
              summary_json: { mismatch_count: 1, retryable_count: 1 },
            },
          ],
        }),
      });
    });
    await page.route("**/api/payments/providers/helcim/events/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          recent_event_count: 3,
          failed_event_count: 1,
          unmatched_event_count: 1,
          ignored_event_count: 0,
          last_event_at: "2026-05-13T12:10:00Z",
          last_failed_message: "Terminal update could not be matched",
        }),
      });
    });
    await page.route("**/api/payments/providers/active", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          helcim: {
            api_token_configured: true,
            terminal_payments_ready: false,
            live_terminal_payments_ready: false,
            simulator_enabled: false,
          },
        }),
      });
    });
    await page.route("**/api/payments/providers/helcim/reconciliation/items?status=open&limit=25", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "pay-1", issue_label: "Missing Payment", severity: "critical", status: "open" }]),
      });
    });

    await signInToBackOffice(page);
    await page.getByRole("button", { name: /^operations center$/i }).click();

    await expect(page.getByTestId("ros-operations-center")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /^ros operations center$/i })).toBeVisible();
    await expect(page.getByText(/overall store readiness/i)).toBeVisible();
    await expect(page.getByText(/blocked/i).first()).toBeVisible();
    await expect(page.getByText(/Store open readiness has blockers/i)).toBeVisible();
    await expect(page.getByText(/Terminal payments not ready/i).first()).toBeVisible();
    await expect(page.getByText(/Review RMS blocking mismatches/i).first()).toBeVisible();
    await expect(page.getByText(/do not treat the queue as clear/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /copy support snapshot/i })).toBeVisible();
    await expect(page.getByText(/ROS Operations Center support snapshot/i)).toBeVisible();

    await page.getByRole("button", { name: /open payments health/i }).click();
    await expect(page.getByTestId("app-shell-state")).toHaveAttribute("data-active-tab", "payments", {
      timeout: 10_000,
    });
  });
});
