import { expect, test } from "@playwright/test";
import { signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
} from "./helpers/openPosRegister";

/**
 * Phase 2 UI smoke: POS tender tabs in checkout drawer.
 *
 * Goal:
 * - Keep this deterministic and lightweight (no hardware dependency).
 * - Prove the checkout drawer opens and key tender tabs are visible/selectable.
 * - Cover conditional tabs:
 *   - Saved Card / Store credit require a linked customer.
 *   - Gift Card requires opening the gift card load flow and adding a line.
 *
 * Run:
 *   cd client
 *   E2E_BASE_URL="http://localhost:5173" npm run test:e2e -- e2e/phase2-tender-ui.spec.ts --workers=1
 */

async function openPosRegisterSurface(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
  await signInToBackOffice(page);

  const posButton = page
    .getByRole("navigation", { name: "Main Navigation" })
    .getByRole("button", { name: "POS", exact: true });
  await expect(posButton).toBeVisible({ timeout: 15_000 });
  await expect(posButton).toBeEnabled();
  await posButton.click();

  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  await expect(posNav).toBeVisible({ timeout: 20_000 });

  await ensurePosRegisterSessionOpen(page);
  const productSearch = page.getByTestId("pos-product-search");
  const giftCardAction = page.getByTestId("pos-action-gift-card");
  const registerTab = page.getByTestId("pos-sidebar-tab-register");
  if (await registerTab.isVisible().catch(() => false)) {
    await expect(registerTab).toBeEnabled();
    await registerTab.click({ timeout: 5_000 }).catch(() => {});
  }
  await ensurePosSaleCashierSignedIn(page);

  await expect(productSearch).toBeVisible({ timeout: 25_000 });
  await expect(giftCardAction).toBeVisible({ timeout: 25_000 });
}

async function seedGiftCardCartLine(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
  await page.getByTestId("pos-action-gift-card").click();

  const dialog = page.getByRole("dialog", { name: /gift card/i });
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // Amount keypad in the modal
  await dialog.getByRole("button", { name: "1", exact: true }).click();
  await dialog.getByRole("button", { name: "0", exact: true }).click();

  // Card code field
  await dialog.getByLabel(/card code/i).fill("E2E-GC-0001");

  await dialog.getByRole("button", { name: /add to cart/i }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function openPaymentLedger(
  page: Parameters<typeof test>[0]["page"],
): Promise<void> {
  const drawer = page.getByRole("dialog", { name: /checkout/i });
  await page.getByRole("button", { name: /pay/i }).first().click();
  const walkInDialog = page.getByRole("dialog", { name: /checkout as walk-in/i });
  if (await walkInDialog.isVisible().catch(() => false)) {
    await walkInDialog.getByRole("button", { name: /confirm walk-in/i }).click();
  }
  await expect(drawer).toBeVisible({ timeout: 20_000 });
}

test.describe("Phase 2: POS tender UI smoke", () => {
  test("checkout drawer shows core tender tabs and complete-sale rail", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openPosRegisterSurface(page);

    // Add an internal gift-card load line so cart has payable amount.
    await seedGiftCardCartLine(page);

    // Open checkout drawer from Pay CTA.
    await openPaymentLedger(page);

    const drawer = page.getByRole("dialog", { name: /checkout/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });

    // Core tabs should always be present.
    await expect(
      drawer.getByRole("button", { name: /STRIPE CARD/i }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: /STRIPE MANUAL/i }),
    ).toBeVisible();
    await expect(drawer.getByRole("button", { name: /^cash$/i })).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: /^check$/i }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: /gift card/i }),
    ).toBeVisible();

    // Complete sale button should exist (enabled state depends on ledger balance).
    await expect(
      drawer.getByRole("button", { name: /finalize|complete sale/i }),
    ).toBeVisible();

    // Smoke-select a few tabs to validate switching works.
    await drawer.getByRole("button", { name: /^cash$/i }).click();
    await drawer.getByRole("button", { name: /^check$/i }).click();
    await drawer.getByRole("button", { name: /STRIPE MANUAL/i }).click();
    await drawer.getByRole("button", { name: /gift card/i }).click();
  });

  test("customer-linked sale shows Saved Card and Store credit tenders", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openPosRegisterSurface(page);

    // Link a customer via deterministic Quick Add flow (avoids search-result variability).
    await page.getByRole("button", { name: /quick add/i }).click();
    await page.getByPlaceholder("First Name").fill("E2E");
    await page.getByPlaceholder("Last Name").fill("Tender UI");
    await page.getByPlaceholder("Phone Number").fill("7165550123");
    await page.getByRole("button", { name: /add & select/i }).click();

    // Wait for customer to be attached to the sale strip.
    await expect(
      page.getByRole("button", { name: /remove customer from sale/i }),
    ).toBeVisible({ timeout: 20_000 });

    // Ensure cart has a payable line (gift card load line is deterministic).
    await seedGiftCardCartLine(page);

    await openPaymentLedger(page);

    const drawer = page.getByRole("dialog", { name: /checkout/i });
    await expect(drawer).toBeVisible({ timeout: 20_000 });

    // Customer-dependent tabs:
    await expect(
      drawer.getByRole("button", { name: /STRIPE VAULT/i }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: /store credit/i }),
    ).toBeVisible();

    // Click-through smoke
    await drawer.getByRole("button", { name: /STRIPE VAULT/i }).click();
    await drawer.getByRole("button", { name: /store credit/i }).click();
  });
});
