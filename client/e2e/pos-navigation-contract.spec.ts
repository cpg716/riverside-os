import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
  enterPosShell,
} from "./helpers/openPosRegister";

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
    page.getByText(/Recent Podium SMS and email threads/i),
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
