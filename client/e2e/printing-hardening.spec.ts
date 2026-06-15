import { expect, test } from "@playwright/test";

test.describe("printing hardening contracts", () => {
  test("inventory tag payloads use fixed LP 2844 EPL2 without hardware", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const payloads = await page.evaluate(async () => {
      const labelPrint = await import("/src/components/inventory/labelPrint.ts");

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
        language: labelPrint.getInventoryTagPrinterLanguage(),
        zpl: labelPrint.buildZplDocument(items, config),
        epl: labelPrint.buildEplDocument(items, config),
      };
    });

    expect(payloads.language).toBe("epl");
    expect(payloads.zpl).toContain("^XA");
    expect(payloads.zpl).toContain("^XZ");
    expect(payloads.zpl.match(/\^XA/g)).toHaveLength(2);
    expect(payloads.zpl).toContain("SKU ONE BAD");
    expect(payloads.zpl).not.toContain("SKU^ONE~BAD");

    expect(payloads.epl).toContain("N\r\nq");
    expect(payloads.epl).toContain("\r\nP1\r\nN\r\n");
    expect(payloads.epl.match(/\r\nP1/g)).toHaveLength(2);
    expect(payloads.epl).toMatch(/B\d+,\d+,[0-3],1,/);
    expect(payloads.epl).not.toContain(",1A,");
    expect(payloads.epl).toContain("SKU^ONE~BAD");
    expect(payloads.epl).not.toContain('"Quoted"');
  });
});
