import { describe, expect, it } from "vitest";
import {
  buildEplDocument,
  buildZplDocument,
  getInventoryTagPrintConfig,
  getInventoryTagPrinterLanguage,
} from "./labelPrint";

const item = {
  sku: "SKU^ONE~BAD",
  productName: "Suit \"Quoted\" <Name>",
  variation: "Navy\n42R",
  brand: "Riversidé",
  price: "$199.99",
  regularPrice: null,
  salePrice: null,
};

describe("LP 2844 EPL2 tag payloads", () => {
  it("terminates the final print command with a newline", () => {
    const epl = buildEplDocument([item], getInventoryTagPrintConfig());

    expect(epl).toMatch(/P1\r?\n$/);
  });

  it("uses Code 128 auto barcode mode instead of fixed 1A mode", () => {
    const epl = buildEplDocument([item], getInventoryTagPrintConfig());

    expect(epl).toMatch(/B\d+,\d+,[0-3],1,/);
    expect(epl).not.toContain(",1A,");
  });

  it("keeps EPL2 text fields printable ASCII", () => {
    const epl = buildEplDocument(
      [item],
      {
        ...getInventoryTagPrintConfig(),
        footerText: "Riverside · Café",
      },
    );

    expect(epl).toContain("Riverside - Cafe");
    expect(epl).not.toContain("·");
    expect(epl).not.toContain("é");
    expect(epl).not.toContain('"Quoted"');
  });

  it("does not emit ZPL when the Riverside tag language is EPL", () => {
    const config = getInventoryTagPrintConfig();
    const epl = buildEplDocument([item], config);
    const zpl = buildZplDocument([item], config);

    expect(getInventoryTagPrinterLanguage()).toBe("epl");
    expect(epl).not.toContain("^XA");
    expect(epl).not.toContain("^XZ");
    expect(zpl).toContain("^XA");
  });
});
