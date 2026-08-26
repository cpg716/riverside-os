import { expect, test } from "@playwright/test";
import {
  buildEplDocument,
  buildZplDocument,
  getInventoryTagPrintConfig,
  getInventoryTagPrinterLanguage,
} from "../src/components/inventory/labelPrint";

test.describe("printing hardening contracts", () => {
  test("inventory tag payloads use fixed LP 2844 EPL2 without hardware", async () => {
    const config = {
      ...getInventoryTagPrintConfig(),
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
    const payloads = {
      language: getInventoryTagPrinterLanguage(),
      zpl: buildZplDocument(items, config),
      epl: buildEplDocument(items, config),
    };

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

  test("inventory tags prefer the product barcode over the ROS SKU", async () => {
    const config = {
      ...getInventoryTagPrintConfig(),
      showBarcode: true,
    };
    const item = {
      sku: "CP-ABCDEFGHIJKLM",
      barcode: "B-1471069",
      productName: "Counterpoint item",
      variation: "Navy / 42R",
      price: "$199.99",
    };

    const epl = buildEplDocument([item], config);

    expect(epl).toContain("CP-ABCDEFGHIJKLM");
    expect(epl).toMatch(/B\d+,\d+,[0-3],1,[12],2,\d+,N,"B-1471069"/);
    expect(epl).not.toMatch(/B\d+,\d+,[0-3],1,[12],2,\d+,N,"CP-ABCDEFGHIJKLM"/);
  });

  test("long fallback SKUs use a one-dot EPL2 barcode module", async () => {
    const config = {
      ...getInventoryTagPrintConfig(),
      showBarcode: true,
    };
    const item = {
      sku: "CP-ABCDEFGHIJKLM",
      productName: "Counterpoint item",
      variation: "Navy / 42R",
      price: "$199.99",
    };

    const epl = buildEplDocument([item], config);

    expect(epl).toMatch(/B\d+,\d+,[0-3],1,1,2,\d+,N,"CP-ABCDEFGHIJKLM"/);
  });
});
