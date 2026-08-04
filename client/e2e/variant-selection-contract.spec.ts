import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  buildVariantSelectionModel,
  initialVariantSelectionPath,
  variantSelectionChoiceLabel,
} from "../src/components/pos/variantSelectionLogic";
import type { VariantOption } from "../src/components/pos/VariantSelectionModal";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function variant(
  variantId: string,
  sku: string,
  variationLabel: string,
): VariantOption {
  return {
    variant_id: variantId,
    sku,
    variation_label: variationLabel,
    stock_on_hand: 1,
    retail_price: "375.00",
  };
}

test("model, size, and style variations retain the common model selection", () => {
  const model = buildVariantSelectionModel([
    variant("v1", "B-1", "46306/3 / 40 R / J BOND"),
    variant("v2", "B-2", "46306/3 / 42 R / J BOND"),
    variant("v3", "B-3", "46306/3 / 42 R / BLACK"),
  ]);

  expect(model.steps).toEqual(["Option 1", "Option 2", "Option 3"]);
  expect(initialVariantSelectionPath(model.entries, "v1")).toEqual([
    "46306/3",
  ]);
  expect(model.entries.find((entry) => entry.variant.variant_id === "v3")?.path)
    .toEqual(["46306/3", "42 R", "BLACK"]);
});

test("single-option shoe sizes remain directly selectable", () => {
  const model = buildVariantSelectionModel([
    variant("v1", "SHOE-10", "10"),
    variant("v2", "SHOE-105", "10.5"),
  ]);

  expect(model.steps).toEqual(["Option 1"]);
  expect(model.entries.map((entry) => entry.path)).toEqual([["10"], ["10.5"]]);
  expect(initialVariantSelectionPath(model.entries, "v2")).toEqual([]);
});

test("shorter variation paths expose an explicit Standard choice", () => {
  const model = buildVariantSelectionModel([
    variant("v1", "MODEL-STD", "MODEL"),
    variant("v2", "MODEL-42", "MODEL / 42"),
  ]);
  const standardPath = model.entries.find(
    (entry) => entry.variant.variant_id === "v1",
  )?.path;

  expect(standardPath).toHaveLength(2);
  expect(variantSelectionChoiceLabel(standardPath?.[1] ?? "")).toBe("Standard");
  expect(initialVariantSelectionPath(model.entries, "v2")).toEqual(["MODEL"]);
});

test("duplicate variation labels require an explicit SKU choice", () => {
  const model = buildVariantSelectionModel([
    variant("v1", "SKU-A", "MODEL / 42 R"),
    variant("v2", "SKU-B", "MODEL / 42 R"),
  ]);

  expect(model.steps).toEqual(["Option 1", "Option 2", "SKU"]);
  expect(model.entries.map((entry) => entry.path.at(-1))).toEqual([
    "SKU SKU-A",
    "SKU SKU-B",
  ]);
  expect(initialVariantSelectionPath(model.entries, "v1")).toEqual([
    "MODEL",
    "42 R",
  ]);
});

test("shared variation drawer keeps item progress visible and supports back/edit", () => {
  const picker = repoFile(
    "client/src/components/pos/VariantSelectionModal.tsx",
  );
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const orderModal = repoFile(
    "client/src/components/pos/OrderLoadModal.tsx",
  );

  expect(picker).toContain('data-testid="variant-item-to-build"');
  expect(picker).toContain("Item to Build");
  expect(picker).toContain('data-testid="variant-selection-back"');
  expect(picker).toContain("Back");
  expect(picker).toContain("if (selections.length === 0)");
  expect(picker).toContain("onClose();");
  expect(picker).toContain("setSelections((previous) => previous.slice(0, -1))");
  expect(picker).toContain("onClick={() => editSelection(index)}");
  expect(picker).toContain("Review pricing below. Use Back");
  expect(picker).toContain('data-testid="variant-line-discount-percent"');
  expect(picker).toContain("Line discount %");
  expect(picker).toContain('data-testid="variant-final-unit-price"');
  expect(picker).toContain("Regular unit price");
  expect(picker).toContain("Final unit price");
  expect(picker).toContain('data-testid="variant-selection-scroll-region"');
  expect(picker).toContain('data-testid="variant-pricing-pinpad"');
  expect(picker).toContain("contentContained");
  expect(picker).not.toContain("Product Confirmation Identity");
  const pinpadStart = picker.indexOf('data-testid="variant-pricing-pinpad"');
  const pinpadMarkup = picker.slice(
    pinpadStart,
    picker.indexOf("</DetailDrawer>"),
  );
  expect(pinpadMarkup).toContain('className="shrink-0');
  expect(pinpadMarkup).not.toContain("overflow-y-auto");
  expect(picker).toContain("!isCurrentVariant || hasPriceChange");
  expect(cart).toContain("<VariantSelectionModal");
  expect(orderModal).toContain("<VariantSelectionModal");
});

test("Update Item changes only the variant and verifies retained customer price", () => {
  const orderModal = repoFile("client/src/components/pos/OrderLoadModal.tsx");
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const server = repoFile("server/src/api/transactions.rs");
  const updateStart = orderModal.indexOf(
    "const ok = await onUpdateOrderItem(selectedOrder, selection.item",
  );
  const updateRequest = orderModal.slice(
    updateStart,
    orderModal.indexOf("if (ok && selectedOrder.id)", updateStart),
  );

  expect(updateRequest).toContain("variant_id: variant.variant_id");
  expect(updateRequest).not.toContain("unit_price:");
  expect(cart).toContain("patch.variant_id !== undefined &&");
  expect(cart).toContain("patch.unit_price === undefined &&");
  expect(cart).toContain("the original customer price was not retained");
  expect(server).toContain("item selection changed from");
  expect(server).toContain("customer price retained at");
  expect(server).toContain('"before": {');
  expect(server).toContain('"after": {');
});
