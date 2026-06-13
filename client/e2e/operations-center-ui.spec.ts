import { expect, test } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

test.describe("ROS Operations Center", () => {
  test("shows source-linked operational timeline items and filters", async ({ page }) => {
    const today = new Date();
    const iso = today.toISOString();
    const dateOnly = iso.slice(0, 10);

    await page.route("**/api/weddings/appointments?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "appt-1",
            starts_at: `${dateOnly}T14:00:00.000Z`,
            customer_display_name: "Timeline Appointment Customer",
            appointment_type: "Fitting",
            status: "scheduled",
            salesperson: "Chris G",
          },
        ]),
      });
    });
    await page.route("**/api/transactions/fulfillment-queue", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            order_id: "txn-timeline-1",
            urgency: "blocked",
            balance_due: 25,
            next_deadline: iso,
            wedding_party_name: "Timeline Pickup Party",
          },
        ]),
      });
    });
    await page.route("**/api/alterations", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "alt-1",
            customer_first_name: "Taylor",
            customer_last_name: "Timeline",
            status: "in_progress",
            due_at: iso,
            item_description: "Suit jacket",
            work_requested: "Sleeves",
            source_type: "past_transaction_line",
            created_at: iso,
          },
        ]),
      });
    });
    await page.route("**/api/tasks/admin/team-open", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            instance_id: "task-timeline-1",
            title_snapshot: "Call timeline customer",
            due_date: dateOnly,
            status: "open",
            assignee_staff_id: "staff-1",
            assignee_name: "Chris G",
            assignee_avatar_key: "chris",
          },
        ]),
      });
    });
    await page.route("**/api/tasks/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ open: [], completed_recent: [] }),
      });
    });
    await page.route("**/api/qbo/staging?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "qbo-timeline-1",
            sync_date: dateOnly,
            journal_entry_id: null,
            status: "pending",
            payload: { warnings: ["Missing account mapping"] },
            error_message: null,
            created_at: iso,
          },
        ]),
      });
    });
    await page.route("**/api/purchase-orders", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "po-timeline-1",
            po_number: "PO-TIMELINE",
            vendor_id: "vendor-1",
            status: "submitted",
            vendor_name: "Timeline Vendor",
            po_kind: "standard",
            expected_at: iso,
          },
        ]),
      });
    });
    await page.route("**/api/inventory/physical/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "physical-timeline-1",
              session_number: "PI-TIMELINE",
              status: "reviewing",
              scope: "full",
              started_at: iso,
              last_saved_at: iso,
              published_at: null,
            },
          ],
        }),
      });
    });
    await page.route("**/api/sessions/list-open", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            session_id: "register-timeline-1",
            register_lane: 1,
            register_ordinal: 1,
            cashier_name: "Chris G",
            opened_at: iso,
            till_close_group_id: "group-1",
            lifecycle_status: "open",
          },
        ]),
      });
    });
    await page.route("**/api/notifications?limit=16", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            staff_notification_id: "staff-note-1",
            notification_id: "note-1",
            created_at: iso,
            kind: "inventory_alert",
            title: "Timeline low stock alert",
            body: "Review stock before pickup.",
            deep_link: {},
            source: "inventory",
            read_at: null,
            completed_at: null,
            archived_at: null,
          },
        ]),
      });
    });
    await page.route("**/api/weddings/morning-compass", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stats: { needs_measure: 1, needs_order: 0, overdue_pickups: 0 },
          needs_measure: [
            {
              id: "wed-timeline-1",
              party_id: "party-timeline-1",
              party_name: "Timeline Wedding",
              customer_name: "Jordan Timeline",
              event_date: dateOnly,
            },
          ],
          needs_order: [],
          overdue_pickups: [],
          rush_orders: [],
          today_floor_staff: [],
        }),
      });
    });
    await page.route("**/api/weddings/activity-feed?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "home");
    const expandSidebar = page.getByRole("button", { name: /^expand sidebar$/i });
    if (await expandSidebar.isVisible().catch(() => false)) {
      await expandSidebar.click();
    }
    await page.getByRole("button", { name: /^timeline$/i }).click();

    await expect(page.getByRole("heading", { name: /^operational timeline$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^agenda$/i })).toHaveAttribute("class", /app-accent/);
    await expect(page.getByRole("button", { name: /^qbo$/i })).toBeVisible();
    await expect(page.getByText("Timeline Appointment Customer")).toBeVisible();
    await expect(page.getByText("Timeline Pickup Party")).toBeVisible();

    await page.getByRole("button", { name: /^qbo$/i }).click();
    await expect(page.getByText("QBO pending")).toBeVisible();
    await page.getByText("QBO pending").click();
    await expect(page.getByTestId("app-shell-state")).toHaveAttribute("data-active-tab", "qbo", {
      timeout: 10_000,
    });
  });

  test("keeps timeline usable on tablet with partial feeds and large result sets", async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1194 });
    const today = new Date();
    const dateOnly = today.toISOString().slice(0, 10);
    const appointmentRows = Array.from({ length: 95 }, (_, index) => ({
      id: `appt-bulk-${index}`,
      starts_at: `${dateOnly}T${String(8 + (index % 10)).padStart(2, "0")}:00:00.000Z`,
      customer_display_name: `Timeline Bulk Customer ${index}`,
      appointment_type: index % 2 === 0 ? "Fitting" : "Pickup consult",
      status: "scheduled",
      salesperson: index % 3 === 0 ? "Chris G" : "Floor team",
    }));

    await page.route("**/api/weddings/appointments?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(appointmentRows),
      });
    });
    await page.route("**/api/transactions/fulfillment-queue", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/alterations", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "alterations unavailable" }),
      });
    });
    await page.route("**/api/tasks/admin/team-open", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/tasks/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ open: [], completed_recent: [] }),
      });
    });
    await page.route("**/api/qbo/staging?*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/purchase-orders", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/inventory/physical/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });
    await page.route("**/api/sessions/list-open", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/notifications?limit=16", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/weddings/morning-compass", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stats: { needs_measure: 0, needs_order: 0, overdue_pickups: 0 },
          needs_measure: [],
          needs_order: [],
          overdue_pickups: [],
          rush_orders: [],
          today_floor_staff: [],
        }),
      });
    });
    await page.route("**/api/weddings/activity-feed?*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "home");
    const expandSidebar = page.getByRole("button", { name: /^expand sidebar$/i });
    if (await expandSidebar.isVisible().catch(() => false)) {
      await expandSidebar.click();
    }
    await page.getByRole("button", { name: /^timeline$/i }).click();

    await expect(page.getByRole("heading", { name: /^operational timeline$/i })).toBeVisible();
    await expect(page.getByTestId("timeline-feed-warning")).toContainText("Alterations could not refresh");
    await expect(page.getByTestId("timeline-result-limit")).toContainText("Showing the nearest 80");
    await expect(page.getByTestId("timeline-result-limit")).toContainText("15 later items");
    await expect(page.getByText("Timeline Bulk Customer 0")).toBeVisible();

    await page.getByRole("button", { name: /^workload$/i }).click();
    await expect(page.getByText("Workload by source")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Appointment\s+95$/i })).toBeVisible();

    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 4,
          ),
        { timeout: 10_000 },
      )
      .toBeTruthy();
  });

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
    await page.route("**/api/order-lifecycle/items", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { lifecycle_status: "ntbo", risk_level: "at_risk", is_rush: true },
          { lifecycle_status: "received", risk_level: "normal", is_rush: false },
        ]),
      });
    });

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "settings");
    const operationsCenterNav = page.getByRole("button", {
      name: /^ros operations & support center/i,
    });
    await expect(operationsCenterNav).toBeVisible({ timeout: 20_000 });
    await operationsCenterNav.click({ force: true });

    await expect(page.getByTestId("ros-operations-center")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /^ros operations & support center$/i })).toBeVisible();

    await page.getByRole("button", { name: /^readiness$/i }).click();
    await expect(page.getByRole("heading", { name: /can riverside os open the store today/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^daily open readiness$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^go-live \/ production certification$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^evidence & support$/i })).toBeVisible();
    await expect(page.getByText(/manual signoff required/i).first()).toBeVisible();
    await expect(page.getByText(/manual signoff required/i).first()).toBeVisible();
    await expect(page.getByText(/payment \/ helcim readiness/i)).toBeVisible();
    await expect(page.getByText(/terminal payments are not ready/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^copy snapshot$/i }).first()).toBeVisible();

    const paymentCheck = page
      .getByText(/payment \/ helcim readiness/i)
      .locator("xpath=ancestor::article[1]");
    await paymentCheck.getByRole("button", { name: /open source/i }).click();
    await expect(page.getByRole("heading", { name: /^integration status monitor$/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});
