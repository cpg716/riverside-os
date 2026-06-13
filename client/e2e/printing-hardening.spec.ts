import { expect, test } from "@playwright/test";

test.describe("printing hardening contracts", () => {
  test("inventory tag payloads support ZPL and EPL without hardware", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const payloads = await page.evaluate(async () => {
      const labelPrint = await import("/src/components/inventory/labelPrint.ts");
      const printerBridge = await import("/src/lib/printerBridge.ts");
      window.localStorage.removeItem(printerBridge.TAG_PRINTER_LANGUAGE_KEY);
      const missingLanguageError = (() => {
        try {
          labelPrint.getInventoryTagPrinterLanguage();
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })();
      window.localStorage.setItem(printerBridge.TAG_PRINTER_LANGUAGE_KEY, "zpl");

      const config = {
        ...labelPrint.getInventoryTagPrintConfig(),
        footerText: "Riverside Test",
        showBarcode: true,
      };
      const items = [
        {
          sku: "SKU^ONE~BAD",
          productName: "Suit \"Quoted\" <Name>",
          variation: "Navy\n42R",
          brand: "Riverside",
          price: "$199.99",
          regularPrice: null,
          salePrice: null,
        },
        {
          sku: "SKU-TWO",
          productName: "Second tag",
          variation: "Black",
          brand: "Riverside",
          price: "$99.99",
          regularPrice: null,
          salePrice: null,
        },
      ];

      return {
        explicitLanguage: labelPrint.getInventoryTagPrinterLanguage(),
        missingLanguageError,
        zpl: labelPrint.buildZplDocument(items, config),
        epl: labelPrint.buildEplDocument(items, config),
      };
    });

    expect(payloads.missingLanguageError).toContain("Choose a Tag printer language");
    expect(payloads.explicitLanguage).toBe("zpl");
    expect(payloads.zpl).toContain("^XA");
    expect(payloads.zpl).toContain("^XZ");
    expect(payloads.zpl.match(/\^XA/g)).toHaveLength(2);
    expect(payloads.zpl).toContain("SKU ONE BAD");
    expect(payloads.zpl).not.toContain("SKU^ONE~BAD");

    expect(payloads.epl).toContain("N\nq");
    expect(payloads.epl).toContain("\nP1\nN\n");
    expect(payloads.epl.match(/\nP1/g)).toHaveLength(2);
    expect(payloads.epl).toContain("SKU^ONE~BAD");
    expect(payloads.epl).not.toContain('"Quoted"');
  });
});
