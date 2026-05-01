import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  e2eBackofficeStaffCode,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

const CUSTOMER_NAME = "E2E Visibility Customer";
const PRODUCT_NAME = "E2E VISIBILITY SUIT";

async function mockDropdownSearches(page: Page): Promise<void> {
  await page.route("**/api/customers/search?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "11111111-1111-4111-8111-111111111111",
          customer_code: "E2E-VIS-1",
          first_name: "E2E",
          last_name: "Visibility Customer",
          email: "e2e.visibility.customer@example.com",
          phone: "716-555-0111",
        },
      ]),
    });
  });

  await page.route("**/api/products/control-board?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            product_id: "22222222-2222-4222-8222-222222222222",
            variant_id: "33333333-3333-4333-8333-333333333333",
            sku: "E2E-VIS-SUIT",
            product_name: PRODUCT_NAME,
            variation_label: "40R",
            retail_price: "199.00",
            cost_price: "90.00",
            stock_on_hand: 5,
            state_tax: "0.00",
            local_tax: "0.00",
            tax_category: "clothing",
          },
        ],
      }),
    });
  });
}

async function openPosRegisterSurface(page: Page): Promise<void> {
  await signInToBackOffice(page);
  const posButton = page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: "POS", exact: true });
  await expect(posButton).toBeVisible({ timeout: 15_000 });
  await expect(posButton).toBeEnabled();
  await posButton.click();

  await expect(
    page.getByRole("navigation", { name: "POS Navigation" }),
  ).toBeVisible({ timeout: 20_000 });

  const laneRequirementDialog = page.getByRole("dialog", {
    name: /cash drawer not open yet/i,
  });
  if (await laneRequirementDialog.isVisible().catch(() => false)) {
    await laneRequirementDialog
      .getByRole("button", { name: /open register #1/i })
      .click();
  }

  const accessRegisterDialog = page.getByRole("dialog", {
    name: /access register|riverside register/i,
  });
  if (await accessRegisterDialog.isVisible().catch(() => false)) {
    for (const digit of e2eBackofficeStaffCode()) {
      await accessRegisterDialog.getByRole("button", { name: digit, exact: true }).click();
    }
    await accessRegisterDialog.getByRole("button", { name: /open register/i }).click();
    await expect(accessRegisterDialog).toBeHidden({ timeout: 30_000 });
  }

  const cartShell = page.getByTestId("pos-register-cart-shell");
  if (!(await cartShell.isVisible().catch(() => false))) {
    const registerNavButton = page
      .getByRole("navigation", { name: "POS Navigation" })
      .getByRole("button", { name: /^register$/i });
    if (await registerNavButton.isVisible().catch(() => false)) {
      await registerNavButton.click().catch(() => {});
    }
  }
  if (!(await cartShell.isVisible().catch(() => false))) {
    const goToRegisterButton = page.getByRole("button", {
      name: /go to register/i,
    });
    if (await goToRegisterButton.isVisible().catch(() => false)) {
      await goToRegisterButton.click().catch(() => {});
    }
  }

  await expect(cartShell).toBeVisible({ timeout: 25_000 });
  await ensurePosSaleCashierSignedIn(page);

  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("pos-customer-search")).toBeVisible({
    timeout: 20_000,
  });
}

async function ensureCartScrollable(page: Page): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await page.getByTestId("pos-action-gift-card").click();
    const dialog = page.getByRole("dialog", { name: /gift card/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: "5", exact: true }).click();
    await dialog.getByLabel(/card code/i).fill(`E2E-VIS-${Date.now()}-${i}`);
    await dialog.getByRole("button", { name: /add to cart/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  }
}

async function scrollNearestContainerNearBottom(locator: Locator): Promise<number> {
  const result = await locator.evaluate((el) => {
    const isScrollable = (node: HTMLElement) => {
      const overflowY = window.getComputedStyle(node).overflowY;
      const allowsScroll =
        overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      return allowsScroll && node.scrollHeight > node.clientHeight;
    };

    let current = el.parentElement as HTMLElement | null;
    while (current) {
      if (isScrollable(current)) {
        current.scrollTop = Math.max(0, current.scrollHeight - current.clientHeight - 24);
        return current.scrollTop;
      }
      current = current.parentElement;
    }

    const root = document.scrollingElement as HTMLElement | null;
    if (root && root.scrollHeight > root.clientHeight) {
      root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - 24);
      return root.scrollTop;
    }

    return 0;
  });

  expect(result > 0).toBeTruthy();
  return result;
}

async function expectLocatorUsable(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible({ timeout: 10_000 });
  await expect(locator).toBeEnabled({ timeout: 10_000 });
}

test("POS dropdowns stay visible near bottom of scrollable cart", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 900, height: 600 });

  await mockDropdownSearches(page);
  await openPosRegisterSurface(page);
  await ensureCartScrollable(page);

  const customerInput = page.getByTestId("pos-customer-search");
  const productInput = page.getByTestId("pos-product-search");

  await scrollNearestContainerNearBottom(customerInput);
  await customerInput.fill("e2e");
  const customerResult = page
    .getByRole("button", { name: new RegExp(CUSTOMER_NAME, "i") })
    .first();
  await expectLocatorUsable(customerResult);
  await customerResult.click();

  await scrollNearestContainerNearBottom(productInput);
  await productInput.fill("e2e-vis");
  const productResult = page
    .getByRole("button", { name: new RegExp(PRODUCT_NAME, "i") })
    .first();
  await expectLocatorUsable(productResult);
  await productResult.click();
});
