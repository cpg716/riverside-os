import { describe, expect, it } from "vitest";
import {
  TAG_LAYOUTS,
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

const retailItem = {
  sku: "B-123456",
  productName: "HSM SLACKS (Custom)",
  variation: "Standard",
  brand: "Hart Schaffner Marx",
  price: "$0.00",
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

  it("prints one command per selected tag", () => {
    const epl = buildEplDocument([item, { ...item, sku: "SKU-TWO" }], getInventoryTagPrintConfig());

    expect(epl.match(/^P1$/gm)).toHaveLength(2);
  });

  it("keeps printer-rendered barcode captions off the physical label", () => {
    const epl = buildEplDocument([item], getInventoryTagPrintConfig());

    expect(epl).not.toMatch(/^B.*?,B,"/m);
    expect(epl).toMatch(/^B.*?,N,"/m);
  });

  it("preserves selected retail EPL layouts and configured content", () => {
    for (const layout of TAG_LAYOUTS) {
      const epl = buildEplDocument(
        [retailItem],
        {
          ...getInventoryTagPrintConfig(),
          tagLayout: layout.id,
          widthInches: 2.25,
          heightInches: 1.25,
          showBarcode: true,
          showPrice: true,
          priceSize: "large",
          footerText: "Riverside Men's Shop",
        },
      );

      expect(epl.match(/^P1$/gm), layout.id).toHaveLength(1);
      expect(epl, `${layout.id} footer`).toContain("Riverside Men's Shop");
      expect(epl, `${layout.id} price`).toContain('"$0.00"');
      expect(epl, `${layout.id} barcode`).toContain('"B-123456"');
      if (layout.id === "barcode-left" || layout.id === "barcode-right") {
        expect(epl, `${layout.id} rotated barcode`).toMatch(/^B\d+,\d+,1,/m);
      } else {
        expect(epl, `${layout.id} horizontal barcode`).toMatch(/^B\d+,\d+,0,/m);
      }
    }
  });

  it("keeps every supported EPL layout inside one physical label", () => {
    for (const layout of TAG_LAYOUTS) {
      const config = {
        ...getInventoryTagPrintConfig(),
        tagLayout: layout.id,
        widthInches: 2.25,
        heightInches: 1.25,
      };
      const epl = buildEplDocument([item], config);
      const width = Number(epl.match(/^q(\d+)/m)?.[1]);
      const height = Number(epl.match(/^Q(\d+),/m)?.[1]);

      expect(Number.isFinite(width), layout.id).toBe(true);
      expect(Number.isFinite(height), layout.id).toBe(true);

      for (const match of epl.matchAll(/^A(\d+),(\d+),([0-3]),([1-5]),(\d+),(\d+),N,/gm)) {
        const [, rawX, rawY, rawRotation, rawFont, , rawYMul] = match;
        const x = Number(rawX);
        const y = Number(rawY);
        const rotation = Number(rawRotation);
        const font = Number(rawFont);
        const yMul = Number(rawYMul);
        const baseHeight = font === 1 ? 16 : font === 2 ? 22 : font === 3 ? 28 : font === 4 ? 32 : 28;
        const renderedHeight = baseHeight * Math.max(1, yMul);

        expect(x, `${layout.id} text x`).toBeGreaterThanOrEqual(0);
        expect(x, `${layout.id} text x`).toBeLessThan(width);
        expect(y, `${layout.id} text y`).toBeGreaterThanOrEqual(0);
        if (rotation === 0) {
          expect(y + renderedHeight, `${layout.id} text bottom`).toBeLessThanOrEqual(height);
        } else {
          expect(y, `${layout.id} rotated text y`).toBeLessThan(height);
        }
      }

      for (const match of epl.matchAll(/^B(\d+),(\d+),([0-3]),1,\d+,\d+,(\d+),N,/gm)) {
        const [, rawX, rawY, rawRotation, rawHeight] = match;
        const x = Number(rawX);
        const y = Number(rawY);
        const rotation = Number(rawRotation);
        const barcodeHeight = Number(rawHeight);

        expect(x, `${layout.id} barcode x`).toBeGreaterThanOrEqual(0);
        expect(x, `${layout.id} barcode x`).toBeLessThan(width);
        expect(y, `${layout.id} barcode y`).toBeGreaterThanOrEqual(0);
        if (rotation === 0) {
          expect(y + barcodeHeight, `${layout.id} barcode bottom`).toBeLessThanOrEqual(height);
        } else {
          expect(y, `${layout.id} rotated barcode y`).toBeLessThan(height);
        }
      }
    }
  });

  it("keeps small-tag prices clear of horizontal barcode bands", () => {
    for (const layout of TAG_LAYOUTS.filter((layout) => layout.id !== "barcode-left" && layout.id !== "barcode-right")) {
      const epl = buildEplDocument(
        [retailItem],
        {
          ...getInventoryTagPrintConfig(),
          tagLayout: layout.id,
          widthInches: 2.25,
          heightInches: 1.25,
          showBarcode: true,
          showPrice: true,
          priceSize: "large",
        },
      );
      const priceMatch = epl.match(/^A(\d+),(\d+),0,5,1,(\d+),N,"\$0\.00"/m);
      const barcodeMatch = epl.match(/^B(\d+),(\d+),0,1,\d+,\d+,(\d+),N,"B-123456"/m);

      expect(priceMatch, `${layout.id} price command`).not.toBeNull();
      expect(barcodeMatch, `${layout.id} barcode command`).not.toBeNull();

      const priceY = Number(priceMatch?.[2]);
      const priceYMul = Number(priceMatch?.[3]);
      const priceBottom = priceY + 28 * Math.max(1, priceYMul);
      const barcodeY = Number(barcodeMatch?.[2]);

      expect(priceBottom + 12, `${layout.id} price/barcode gap`).toBeLessThanOrEqual(barcodeY);
    }
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
