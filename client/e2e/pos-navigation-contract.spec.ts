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
  expect(scrollState.railTopAfter).toBe(scrollState.railTopBefore);
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

  await expect(
    posNav.getByRole("button", { name: "RMS Charge", exact: true }),
  ).toBeVisible();
  await expect(
    posNav.getByRole("button", { name: "Podium Inbox", exact: true }),
  ).toBeVisible();

  await posNav.getByRole("button", { name: "Podium Inbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(
    page.getByText(/Synced Podium conversations for matched customers/i),
  ).toBeVisible();

  await posNav.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(
    posNav.getByRole("button", { name: /Purchase Orders|Receiving|Vendors|Add Item/i }),
  ).toHaveCount(0);
});

test("rapid POS rail tab changes stay in POS mode and land on the final tab", async ({
  page,
}) => {
  const posNav = await openClickablePosRail(page);

  const appShell = page.getByTestId("app-shell-state");
  const posShell = page.getByTestId("pos-shell-root");

  await expect(appShell).toHaveAttribute("data-pos-mode", "true");

  for (const label of [
    "Customers",
    "Podium Inbox",
    "Orders",
    "Settings",
    "Inventory",
  ]) {
    await posNav.getByRole("button", { name: label, exact: true }).click();
  }

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
  await expect(
    posNav.getByRole("button", { name: "Podium Inbox", exact: true }),
  ).toBeVisible();
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
  await expect(page.getByText(/Register command center/i)).toBeVisible({
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
