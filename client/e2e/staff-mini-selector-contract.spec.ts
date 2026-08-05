import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test("staff selections close without parent labels reactivating the trigger", () => {
  const selector = repoFile("client/src/components/ui/StaffMiniSelector.tsx");
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const weddingHealth = repoFile(
    "client/src/components/wedding-manager/components/WeddingHealthHeatmap.tsx",
  );

  expect(selector).toContain("event.preventDefault()");
  expect(selector).toContain("event.stopPropagation()");
  expect(selector).toContain("setIsOpen(false)");

  const cartSelector = cart.slice(
    cart.indexOf('placeholder="Select Salesperson..."') - 700,
    cart.indexOf('placeholder="Select Salesperson..."') + 300,
  );
  expect(cartSelector).not.toContain("<label");

  const weddingSelector = weddingHealth.slice(
    weddingHealth.indexOf("<StaffMiniSelector") - 500,
    weddingHealth.indexOf("<StaffMiniSelector") + 500,
  );
  expect(weddingSelector).not.toContain("<label");
});

test("the Register primary salesperson menu shows the full roster", () => {
  const selector = repoFile("client/src/components/ui/StaffMiniSelector.tsx");
  const cart = repoFile("client/src/components/pos/Cart.tsx");

  expect(selector).toContain("showFullList?: boolean");
  expect(selector).toContain(
    'showFullList ? "overflow-visible" : "max-h-[15rem] overflow-y-auto"',
  );

  const cartSelector = cart.slice(
    cart.indexOf('placeholder="Select Salesperson..."') - 500,
    cart.indexOf('placeholder="Select Salesperson..."') + 500,
  );
  expect(cartSelector).toContain("showFullList");
});

test("native labels do not wrap action buttons or shared selectors", () => {
  const files = [
    "client/src/components/inventory/QuickProcurementItemModal.tsx",
    "client/src/components/inventory/VariationsWorkspace.tsx",
    "client/src/components/operations/MailboxOperationsSection.tsx",
    "client/src/components/pos/Cart.tsx",
    "client/src/components/pos/OrderLoadModal.tsx",
    "client/src/components/pos/RegisterSettings.tsx",
    "client/src/components/settings/IntegrationCredentialsCard.tsx",
    "client/src/components/settings/ReceiptBuilderPanel.tsx",
    "client/src/components/ui/AddressAutocompleteInput.tsx",
    "client/src/components/wedding-manager/components/WeddingHealthHeatmap.tsx",
  ];

  for (const file of files) {
    const source = repoFile(file);
    const interactiveLabels = [...source.matchAll(/<label\b[\s\S]*?<\/label>/g)]
      .map((match) => match[0])
      .filter((label) => /<(?:button|StaffMiniSelector)\b/.test(label));

    expect(
      interactiveLabels,
      `${file} contains an interactive control inside a native label`,
    ).toEqual([]);
  }
});
