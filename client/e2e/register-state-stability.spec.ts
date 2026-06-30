import { expect, test, type Page, type Route } from "@playwright/test";

const BO_SESSION_KEY = "ros.backoffice.session.v1";
const POS_SESSION_KEY = "ros.posRegisterAuth.v1";

const adminPermissions = [
  "admin",
  "operations.view",
  "pos.access",
  "register.open",
  "register.session_attach",
  "settings.view",
];

const registerSession = {
  session_id: "session-register-1",
  register_lane: 1,
  register_ordinal: 1,
  cashier_name: "Anthony Polichetti",
  cashier_avatar_key: "ros_default",
  cashier_avatar_photo_url: null,
  cashier_code: "1111",
  lifecycle_status: "open",
  role: "salesperson",
  receipt_timezone: "America/New_York",
  opening_float: "200.00",
  opened_at: "2026-06-30T13:00:00.000Z",
  till_close_group_id: "till-group-1",
};

async function seedBackofficeSession(page: Page, stationLabel?: string) {
  await page.addInitScript(
    ({ boKey, posKey, label }) => {
      window.sessionStorage.setItem(
        boKey,
        JSON.stringify({ staffCode: "1234", staffPin: "1234" }),
      );
      window.sessionStorage.removeItem(posKey);
      if (label) {
        window.localStorage.setItem("ros.station.label", label);
      } else {
        window.localStorage.removeItem("ros.station.label");
      }
    },
    { boKey: BO_SESSION_KEY, posKey: POS_SESSION_KEY, label: stationLabel },
  );
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installApiMocks(
  page: Page,
  options: { staffCurrentSessionStatus: 200 | 404 },
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/staff/effective-permissions") {
      return json(route, {
        permissions: adminPermissions,
        full_name: "Chris G",
        avatar_key: "ros_default",
        avatar_photo_url: null,
        staff_id: "staff-chris",
        id: "staff-chris",
        role: "admin",
        employee_customer_id: null,
      });
    }

    if (path === "/api/ops/stations/heartbeat") {
      return json(route, { ok: true });
    }

    if (path === "/api/staff/list-for-pos") {
      return json(route, [
        { staff_id: "staff-chris", full_name: "Chris G", cashier_code: "1234" },
        {
          staff_id: "staff-anthony",
          full_name: registerSession.cashier_name,
          cashier_code: registerSession.cashier_code,
        },
      ]);
    }

    if (path === "/api/settings/pos-station-config/public") {
      return json(route, { max_register_lanes: 4 });
    }

    if (path === "/api/sessions/current") {
      const hasPosToken = Boolean(request.headers()["x-riverside-pos-session-id"]);
      if (!hasPosToken && options.staffCurrentSessionStatus === 404) {
        return json(route, { error: "No active session found" }, 404);
      }
      return json(route, registerSession);
    }

    if (path === "/api/sessions/list-open") {
      return json(route, [registerSession]);
    }

    if (method === "POST" && path === "/api/sessions/open") {
      return json(
        route,
        { error: "register_lane_in_use", register_lane: 1 },
        409,
      );
    }

    if (
      method === "POST" &&
      path === `/api/sessions/${registerSession.session_id}/attach`
    ) {
      return json(route, { pos_api_token: "attached-token-1" });
    }

    if (path === "/api/staff/verify-pin") {
      return json(route, { staff_id: "staff-chris", full_name: "Chris G" });
    }

    if (path === "/api/weather/snapshot") {
      return json(route, null);
    }

    if (path.startsWith("/api/notifications")) {
      return json(route, []);
    }

    if (path.includes("morning-compass")) {
      return json(route, {
        stats: { needs_measure: 0, needs_order: 0, overdue_pickups: 0 },
        needs_measure: [],
        needs_order: [],
        overdue_pickups: [],
        rush_orders: [],
        today_floor_staff: [],
      });
    }

    if (path.includes("sales-pivot") || path.includes("operations")) {
      return json(route, {});
    }

    return json(route, []);
  });
}

test.describe("register state stability", () => {
  test("Back Office top bar keeps authenticated staff separate from Register #1 cashier", async ({
    page,
  }) => {
    await seedBackofficeSession(page);
    await installApiMocks(page, { staffCurrentSessionStatus: 200 });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const header = page.locator("header").first();
    await expect(header.getByText("Chris G")).toBeVisible({ timeout: 20_000 });
    await expect(header.getByText("Anthony Polichetti")).toHaveCount(0);
  });

  test("Register #1 station attaches to an already-open lane after local POS state is lost", async ({
    page,
  }) => {
    await seedBackofficeSession(page, "Register #1");
    await installApiMocks(page, { staffCurrentSessionStatus: 404 });

    await page.goto("/pos", { waitUntil: "domcontentloaded" });

    const registerPanel = page.getByTestId("pos-register-panel");
    await expect(registerPanel).toHaveAttribute("data-register-state", "needs-open", {
      timeout: 20_000,
    });

    const terminalSelect = page
      .getByRole("dialog", { name: "Open Register" })
      .getByRole("combobox");
    await expect(terminalSelect).toHaveValue("1");
    await expect(terminalSelect).toBeDisabled();

    for (const digit of "1234") {
      await page.getByTestId(`pin-key-${digit}`).click();
    }

    await expect(registerPanel).toHaveAttribute("data-register-state", "mounted", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("pos-register-cart-shell")).toBeVisible();
    await expect(page.getByText(/already has an open session/i)).toHaveCount(0);
  });
});
