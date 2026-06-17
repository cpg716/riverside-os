import { describe, expect, it } from "vitest";
import {
  buildEplDocument,
  buildInventoryTagFooterLine,
  buildZplDocument,
  defaultCustomTagLayout,
  defaultSaleCustomTagLayout,
  formatInventoryTagPrintDate,
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

const retailItem = {
  sku: "B-123456",
  productName: "HSM SLACKS (Custom)",
  variation: "Standard",
  brand: "Hart Schaffner Marx",
  price: "$0.00",
  regularPrice: null,
  salePrice: null,
};

const saleRetailItem = {
  ...retailItem,
  price: "$119.00",
  regularPrice: "$149.00",
  salePrice: "$119.00",
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

  it("prints one command per selected tag", () => {
    const epl = buildEplDocument([item, { ...item, sku: "SKU-TWO" }], getInventoryTagPrintConfig());

    expect(epl.match(/^P1$/gm)).toHaveLength(2);
  });

  it("keeps printer-rendered barcode captions off the physical label", () => {
    const epl = buildEplDocument([item], getInventoryTagPrintConfig());

    expect(epl).not.toMatch(/^B.*?,B,"/m);
    expect(epl).toMatch(/^B.*?,N,"/m);
  });

  it("uses the Tag Builder layout for test and real retail EPL content", () => {
    const epl = buildEplDocument(
      [retailItem],
      {
        ...getInventoryTagPrintConfig(),
        tagLayout: "barcode-left",
        widthInches: 2.25,
        heightInches: 1.25,
        showBarcode: true,
        showPrice: true,
        priceSize: "large",
        footerText: "Riverside Men's Shop",
      },
    );

    expect(epl.match(/^P1$/gm)).toHaveLength(1);
    expect(epl).toContain("Riverside Men's Shop");
    expect(epl).toContain('"$0.00"');
    expect(epl).toContain('"B-123456"');
    expect(epl).toMatch(/^B\d+,\d+,0,/m);
  });

  it("prints sale tag pricing as separate builder fields", () => {
    const epl = buildEplDocument(
      [saleRetailItem],
      {
        ...getInventoryTagPrintConfig(),
        widthInches: 2.25,
        heightInches: 1.25,
        showBarcode: true,
        showPrice: true,
        showPromoPrice: true,
        priceSize: "large",
        footerText: "Riverside Men's Shop",
      },
    );

    expect(epl).toContain('"Reg $149.00"');
    expect(epl).toContain('"$119.00"');
    expect(epl).toContain('"Save $30.00"');
    expect(epl).toContain('"B-123456"');
  });

  it("shrinks large sale prices to stay inside the builder price box", () => {
    const config = {
      ...getInventoryTagPrintConfig(),
      widthInches: 2.25,
      heightInches: 1.25,
      showBarcode: true,
      showPrice: true,
      showPromoPrice: true,
      priceSize: "large",
      footerText: "Riverside Men's Shop",
      saleCustomLayout: defaultSaleCustomTagLayout(),
    };
    const epl = buildEplDocument([saleRetailItem], config);

    expect(epl).toMatch(/^A\d+,\d+,0,[1-4],1,\d+,N,"\$119\.00"/m);
    expect(epl).not.toMatch(/^A\d+,\d+,0,5,1,\d+,N,"\$119\.00"/m);
  });

  it("prints XXL price text when the builder price box has enough room", () => {
    const customLayout = defaultSaleCustomTagLayout();
    customLayout.elements.price = {
      ...customLayout.elements.price,
      xPct: 0,
      yPct: 50,
      wPct: 65,
      hPct: 36,
      fontSize: "xxl",
    };
    const epl = buildEplDocument(
      [saleRetailItem],
      {
        ...getInventoryTagPrintConfig(),
        widthInches: 2.25,
        heightInches: 1.25,
        showPrice: true,
        showPromoPrice: true,
        saleCustomLayout: customLayout,
      },
    );

    expect(epl).toMatch(/^A\d+,\d+,0,5,1,2,N,"\$119\.00"/m);
  });

  it("prints hero price text for six digit prices when the price box uses the tag width", () => {
    const customLayout = defaultCustomTagLayout();
    customLayout.elements.price = {
      ...customLayout.elements.price,
      xPct: 0,
      yPct: 45,
      wPct: 100,
      hPct: 45,
      fontSize: "hero",
    };
    const epl = buildEplDocument(
      [{ ...retailItem, price: "$999.00" }],
      {
        ...getInventoryTagPrintConfig(),
        widthInches: 2.25,
        heightInches: 1.25,
        showPrice: true,
        customLayout,
      },
    );

    expect(epl).toMatch(/^A0,\d+,0,5,2,2,N,"\$999\.00"/m);
  });

  it("honors per-field text size from the tag builder", () => {
    const customLayout = defaultCustomTagLayout();
    customLayout.elements.productName = {
      ...customLayout.elements.productName,
      fontSize: "xs",
    };
    const epl = buildEplDocument(
      [retailItem],
      {
        ...getInventoryTagPrintConfig(),
        widthInches: 2.25,
        heightInches: 1.25,
        customLayout,
      },
    );

    expect(epl).toMatch(/^A\d+,\d+,0,1,1,\d+,N,"HSM SLACKS"/m);
  });

  it("formats tag footers with the print job date", () => {
    const printedAt = new Date("2026-06-17T14:30:00-04:00");

    expect(formatInventoryTagPrintDate(printedAt)).toBe("Jun 17, 2026");
    expect(buildInventoryTagFooterLine("Riverside Men's Shop", printedAt)).toBe("Riverside Men's Shop · Jun 17, 2026");
  });

  it("keeps regular and sale builder layouts independent", () => {
    const regularLayout = defaultCustomTagLayout();
    const saleLayout = defaultSaleCustomTagLayout();
    saleLayout.elements.barcode = {
      ...saleLayout.elements.barcode,
      xPct: 72,
      yPct: 12,
      wPct: 18,
      hPct: 60,
      direction: "rotated-right",
    };

    const config = {
      ...getInventoryTagPrintConfig(),
      widthInches: 2.25,
      heightInches: 1.25,
      customLayout: regularLayout,
      saleCustomLayout: saleLayout,
    };

    const regularEpl = buildEplDocument([retailItem], config);
    const saleEpl = buildEplDocument([saleRetailItem], config);

    expect(regularEpl).toMatch(/^B\d+,\d+,0,1,/m);
    expect(saleEpl).toMatch(/^B\d+,\d+,1,1,/m);
  });

  it("keeps Tag Builder EPL commands inside one physical label", () => {
    const config = {
      ...getInventoryTagPrintConfig(),
      widthInches: 2.25,
      heightInches: 1.25,
    };
    const epl = buildEplDocument([item], config);
    const width = Number(epl.match(/^q(\d+)/m)?.[1]);
    const height = Number(epl.match(/^Q(\d+),/m)?.[1]);

    expect(Number.isFinite(width)).toBe(true);
    expect(Number.isFinite(height)).toBe(true);

    for (const match of epl.matchAll(/^A(\d+),(\d+),([0-3]),([1-5]),(\d+),(\d+),N,/gm)) {
      const [, rawX, rawY] = match;
      const x = Number(rawX);
      const y = Number(rawY);

      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(height);
    }

    for (const match of epl.matchAll(/^B(\d+),(\d+),([0-3]),1,\d+,\d+,(\d+),N,/gm)) {
      const [, rawX, rawY] = match;
      const x = Number(rawX);
      const y = Number(rawY);

      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(height);
    }
  });

  it("lets the builder move and rotate barcode independently of price", () => {
    const customLayout = defaultCustomTagLayout();
    customLayout.elements.barcode = {
      ...customLayout.elements.barcode,
      xPct: 72,
      yPct: 12,
      wPct: 18,
      hPct: 60,
      direction: "rotated-right",
    };
    const epl = buildEplDocument(
      [retailItem],
      {
        ...getInventoryTagPrintConfig(),
        widthInches: 2.25,
        heightInches: 1.25,
        showBarcode: true,
        showPrice: true,
        priceSize: "large",
        customLayout,
      },
    );

    const priceMatch = epl.match(/^A(\d+),(\d+),0,5,1,\d+,N,"\$0\.00"/m);
    const barcodeMatch = epl.match(/^B(\d+),(\d+),1,1,\d+,\d+,\d+,N,"B-123456"/m);

    expect(priceMatch).not.toBeNull();
    expect(barcodeMatch).not.toBeNull();
    expect(Number(barcodeMatch?.[1])).toBeGreaterThan(Number(priceMatch?.[1]));
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
