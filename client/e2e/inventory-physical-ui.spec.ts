import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab, signInToBackOffice } from "./helpers/backofficeSignIn";
import {
  getInventoryIntelligence,
  uniqueSuffix,
} from "./helpers/inventoryReceiving";
import {
  addPhysicalInventoryCount,
  cancelActivePhysicalInventorySession,
  createCategoryScopedPhysicalInventorySession,
  createPhysicalInventorySkuPair,
  movePhysicalInventorySessionToReview,
} from "./helpers/inventoryPhysical";

async function openInventoryPhysicalCount(page: Parameters<typeof test>[0]["page"]) {
  await openBackofficeSidebarTab(page, "inventory");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText(/^inventory$/i),
  ).toBeVisible({ timeout: 15_000 });
  const physicalCountButton = page.getByRole("button", {
    name: /^count\/(?:review|reconcile)$/i,
  });
  await expect(physicalCountButton).toBeVisible({ timeout: 15_000 });
  await physicalCountButton.click({ force: true });
  await expect(page.getByRole("heading", { name: /count\/review|physical inventory|review phase/i }).first()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("Physical inventory review and publish verification", () => {
  test("review surfaces missing SKUs in the count area and publishes reviewed stock", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix("ui-physical");
    await cancelActivePhysicalInventorySession(request);

    const { category, countedProduct, missingProduct } =
      await createPhysicalInventorySkuPair(request, suffix);
    const session = await createCategoryScopedPhysicalInventorySession(request, category.id);
    await addPhysicalInventoryCount(request, session.id, countedProduct.variantId, 1);
    await movePhysicalInventorySessionToReview(request, session.id);

    await signInToBackOffice(page, { persistSession: true });
    await openInventoryPhysicalCount(page);

    const reviewHeading = page.getByRole("heading", {
      name: new RegExp(`review phase .*${session.session_number}`, "i"),
    });
    const goToReviewButton = page.getByRole("button", { name: /go to review/i });
    if (await goToReviewButton.isVisible().catch(() => false)) {
      await goToReviewButton.click();
    }

    await expect(reviewHeading).toBeVisible({
      timeout: 20_000,
    });

    const countedRow = page.locator("tr").filter({ hasText: countedProduct.sku }).first();
    const missingRow = page.locator("tr").filter({ hasText: missingProduct.sku }).first();
    await expect(countedRow).toBeVisible({ timeout: 15_000 });
    await expect(missingRow).toBeVisible({ timeout: 15_000 });
    await expect(missingRow).toContainText(/not counted/i);
    await expect(missingRow).toContainText(/\b-2\b/);

    await expect(page.getByText(/1 sku.*in this area.*never counted/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/what changed if published/i)).toBeVisible();
    await expect(page.getByText(/does not replay receiving, sales/i)).toBeVisible();
    await expect(page.getByText(/retrying refresh is safe and does not update live stock/i)).toBeVisible();
    await page.getByRole("button", { name: /publish reviewed counts/i }).click();

    const publishDialog = page.getByText(
      new RegExp(
        `${session.session_number}.*updates live inventory.*2 items are in scope, 1 were counted, 1 are missing from count, and the net change is -5`,
        "i",
      ),
    );
    await expect(publishDialog).toBeVisible({ timeout: 10_000 });

    const publishResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/inventory/physical/sessions/${session.id}/publish`) &&
        response.request().method() === "POST" &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: /^publish reviewed counts$/i }).last().click();
    await publishResponse;

    await expect(page.getByText(/publish completed/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/live inventory was updated from the reviewed counts/i)).toBeVisible();

    await expect
      .poll(async () => (await getInventoryIntelligence(request, countedProduct.variantId)).stock_on_hand, {
        timeout: 15_000,
      })
      .toBe(1);
    await expect
      .poll(async () => (await getInventoryIntelligence(request, missingProduct.variantId)).stock_on_hand, {
        timeout: 15_000,
      })
      .toBe(0);
  });
});
