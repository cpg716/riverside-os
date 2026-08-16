import { expect, test } from "@playwright/test";
import {
  ensureMainNavigationVisible,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
  enterPosShell,
} from "./helpers/openPosRegister";

test.describe.configure({ timeout: 60_000 });

test("Back Office sidebar stays fixed while the workspace scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signInToBackOffice(page);

  const mainNav = await ensureMainNavigationVisible(page);
  await expect(mainNav).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Action Board/i)).toBeVisible({ timeout: 20_000 });

  const scrollState = await page.evaluate(() => {
    const scroller = document.scrollingElement as HTMLElement | null;
    const nav = document.querySelector(
      '[aria-label="Main Navigation"]',
    ) as HTMLElement | null;
    const rail = nav?.closest("aside") as HTMLElement | null;
    const railTopBefore = rail?.getBoundingClientRect().top ?? null;

    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollTop = 360;
    }
    const railTopAfter = rail?.getBoundingClientRect().top ?? null;

    return {
      documentScrollTop: scroller?.scrollTop ?? 0,
      railTopBefore,
      railTopAfter,
      railOverflowY: rail ? getComputedStyle(rail).overflowY : "",
    };
  });

  expect(scrollState.documentScrollTop).toBeGreaterThan(0);
  expect(scrollState.railOverflowY).toBe("hidden");
  expect(scrollState.railTopBefore).not.toBeNull();
  expect(Math.abs((scrollState.railTopAfter ?? 0) - (scrollState.railTopBefore ?? 0))).toBeLessThanOrEqual(0.5);
});

async function openClickablePosRail(page: Parameters<typeof signInToBackOffice>[0]) {
  await signInToBackOffice(page);
  await enterPosShell(page);
  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);

  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  await expect(posNav).toBeVisible({ timeout: 20_000 });

  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  if (await expandSidebar.isVisible().catch(() => false)) {
    await expandSidebar.click();
    await expect(
      page.getByRole("button", { name: "Collapse Sidebar" }),
    ).toBeVisible({ timeout: 10_000 });
  }

  return posNav;
}

test("POS navigation uses the narrowed POS-native section contract", async ({ page }) => {
  const posNav = await openClickablePosRail(page);

  await expect
    .poll(() => posNav.evaluate((element) => getComputedStyle(element).scrollbarWidth))
    .toBe("none");
  await expect(page.getByRole("button", { name: "Wedding Manager" })).toHaveClass(
    /bg-violet-500\/20/,
  );
  await expect(page.getByRole("button", { name: "Clear Sale" })).toBeVisible();
  await expect(page.getByTestId("pos-camera-scan-button")).toBeVisible();
  await expect(page.getByTestId("pos-parked-sales-button")).toHaveCount(0);
  await page.getByTestId("pos-camera-scan-button").click();
  const cameraScanner = page.getByRole("dialog", {
    name: "Register Product Scan",
  });
  await expect(cameraScanner).toBeVisible();
  await cameraScanner.getByRole("button", { name: "Close scanner" }).click();
  await expect(cameraScanner).toHaveCount(0);
  await page.getByRole("button", { name: "More Actions" }).click();
  const moreActions = page.getByRole("dialog", { name: "More sale actions" });
  await expect(
    moreActions.getByRole("button", { name: /Resume Parked Sale/ }),
  ).toBeVisible();
  await moreActions
    .getByRole("button", { name: /Resume Parked Sale/ })
    .click();
  const parkedSales = page.getByRole("dialog", {
    name: "Resume Parked Sale",
  });
  await expect(parkedSales).toBeVisible();
  await parkedSales.getByRole("button", { name: "Close" }).click();
  await expect(parkedSales).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suit Swap" })).toHaveCount(0);
  await page.getByRole("button", { name: "More Actions" }).click();
  await expect(page.getByRole("button", { name: "Suit Swap" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "More sale actions" }).getByRole("button", { name: "Clear Sale" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close more sale actions" }).click();
  await expect(page.getByTestId("pos-alteration-intake-trigger")).toHaveClass(
    /bg-app-warning\/20/,
  );
  await expect(page.getByTestId("pos-exchange-wizard-trigger")).toHaveClass(
    /bg-app-danger\/15/,
  );

  // Cart workspace actions intentionally collapse the rail to restore selling
  // space. Re-open it before asserting the active workspace's sub-navigation.
  const expandSidebar = page.getByRole("button", { name: "Expand sidebar" });
  if (await expandSidebar.isVisible().catch(() => false)) {
    await expandSidebar.click();
  }
  await posNav.getByRole("button", { name: "Customers", exact: true }).click();
  await expect(posNav.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(posNav.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await expect(
    posNav.getByRole("button", { name: "Duplicate Review", exact: true }),
  ).toBeVisible();
  await expect(
    posNav.getByRole("button", { name: "Shipments Hub", exact: true }),
  ).toHaveCount(0);
  await expect(
    posNav.getByRole("button", { name: "Purchase Orders", exact: true }),
  ).toHaveCount(0);

  await expect(posNav.getByTestId("pos-sidebar-group-work")).toHaveCount(0);
  await expect(posNav.getByTestId("pos-sidebar-group-more")).toHaveCount(0);
  await expect(posNav.getByRole("button", { name: "Podium Inbox", exact: true })).toBeVisible();
  await expect(posNav.getByRole("button", { name: "Mailbox", exact: true })).toBeVisible();

  await posNav.getByRole("button", { name: "Mailbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();

  await posNav.getByRole("button", { name: "Podium Inbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(
    page.getByText("Customer messages, calls, and linked reviews in one shared list."),
  ).toBeVisible();

  await posNav.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(
    posNav.getByRole("button", { name: /Purchase Orders|Receiving|Vendors|Add Item/i }),
  ).toHaveCount(0);
});

test("Close Register opens one End of Shift dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openClickablePosRail(page);

  const closeRegister = page.getByRole("button", {
    name: "Close Register",
    exact: true,
  });
  await expect(closeRegister).toBeVisible({ timeout: 20_000 });
  await closeRegister.click();

  const endOfShift = page.getByRole("dialog", {
    name: "End of Shift",
    exact: true,
  });
  await expect(endOfShift).toHaveCount(1);
  await endOfShift.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(endOfShift).toHaveCount(0);
});

test("rapid POS rail tab changes stay in POS mode and land on the final tab", async ({
  page,
}) => {
  const posNav = await openClickablePosRail(page);

  const appShell = page.getByTestId("app-shell-state");
  const posShell = page.getByTestId("pos-shell-root");

  await expect(appShell).toHaveAttribute("data-pos-mode", "true");

  await posNav.getByRole("button", { name: "Customers", exact: true }).click();
  await posNav.getByRole("button", { name: "Podium Inbox", exact: true }).click();
  await posNav.getByRole("button", { name: "Orders", exact: true }).click();
  await posNav.getByRole("button", { name: "Settings", exact: true }).click();
  await posNav.getByRole("button", { name: "Inventory", exact: true }).click();

  await expect(appShell).toHaveAttribute("data-pos-mode", "true");
  await expect(posShell).toHaveAttribute("data-pos-active-tab", "inventory");
  await expect(posNav.getByRole("button", { name: "Inventory", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("navigation", { name: "Main Navigation" })).toHaveCount(0);
  await expect(
    posNav.getByRole("button", { name: /Purchase Orders|Receiving|Vendors|Add Item/i }),
  ).toHaveCount(0);
  await expect(posNav.getByTestId("pos-sidebar-group-work")).toHaveCount(0);
  await expect(
    posNav.getByRole("button", { name: "RMS Charge", exact: true }),
  ).toBeVisible();
});

test("POS dashboard keeps the POS rail fixed while the workspace scrolls", async ({
  page,
}) => {
  const posNav = await openClickablePosRail(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  await posNav.getByRole("button", { name: "Dashboard", exact: true }).click();

  const posShell = page.getByTestId("pos-shell-root");
  await expect(posShell).toHaveAttribute("data-pos-active-tab", "pos-dashboard");
  await expect(page.getByRole("heading", { name: "Priority Feed" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("pos-dashboard-scroll")).toBeVisible();

  const scrollState = await page.evaluate(() => {
    const scroller = document.scrollingElement as HTMLElement | null;
    const shell = document.querySelector(
      '[data-testid="pos-shell-root"]',
    ) as HTMLElement | null;
    const workspace = document.querySelector(
      '[data-testid="pos-dashboard-scroll"]',
    ) as HTMLElement | null;
    const rail = document
      .querySelector('[aria-label="POS Navigation"]')
      ?.closest("aside") as HTMLElement | null;
    const railTopBefore = rail?.getBoundingClientRect().top ?? null;

    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollTop = 240;
    }
    if (workspace) {
      workspace.scrollTop = 0;
      workspace.scrollTop = 240;
    }
    const railTopAfter = rail?.getBoundingClientRect().top ?? null;

    return {
      documentScrollTop: scroller?.scrollTop ?? 0,
      workspaceScrollTop: workspace?.scrollTop ?? 0,
      workspaceScrollHeight: workspace?.scrollHeight ?? 0,
      workspaceClientHeight: workspace?.clientHeight ?? 0,
      railTopBefore,
      railTopAfter,
      shellOverflowY: shell ? getComputedStyle(shell).overflowY : "",
      workspaceOverflowY: workspace ? getComputedStyle(workspace).overflowY : "",
    };
  });

  expect(scrollState.documentScrollTop).toBe(0);
  expect(scrollState.workspaceScrollHeight).toBeGreaterThan(
    scrollState.workspaceClientHeight,
  );
  expect(scrollState.workspaceScrollTop).toBeGreaterThan(0);
  expect(scrollState.shellOverflowY).toBe("hidden");
  expect(scrollState.workspaceOverflowY).toBe("auto");
  expect(scrollState.railTopBefore).not.toBeNull();
  expect(scrollState.railTopAfter).toBe(scrollState.railTopBefore);
});
