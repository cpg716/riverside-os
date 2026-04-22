import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test("POS navigation uses the narrowed POS-native section contract", async ({ page }) => {
  await signInToBackOffice(page);

  await page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: "POS", exact: true })
    .click();

  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  await expect(posNav).toBeVisible({ timeout: 20_000 });

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

  await posNav.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(
    posNav.getByRole("button", { name: /Purchase Orders|Receiving|Vendors|Add Item/i }),
  ).toHaveCount(0);
});
