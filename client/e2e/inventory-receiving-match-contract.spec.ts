import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  matchReceivingVariantIndex,
  stageReceivingVariantScan,
} from "../src/components/inventory/receivingLineMatcher";

const lines = [{ variant_id: "variant-a" }, { variant_id: "variant-b" }];

test.describe("receiving scan match contract", () => {
  test("maps an authoritative variation id to its purchase-order line", () => {
    expect(matchReceivingVariantIndex(lines, "VARIANT-B")).toBe(1);
  });

  test("rejects duplicate purchase-order lines for one authoritative variation", () => {
    expect(
      matchReceivingVariantIndex(
        [{ variant_id: "variant-a" }, { variant_id: "variant-a" }],
        "variant-a",
      ),
    ).toBe(-2);
  });

  test("never treats the original scan text as purchase-order identity", () => {
    expect(matchReceivingVariantIndex(lines, "sku-a")).toBe(-1);
  });

  test("bounds queued scans against the latest staged quantity", () => {
    const first = stageReceivingVariantScan(
      [
        {
          variant_id: "variant-a",
          qty_ordered: 1,
          qty_previously_received: 0,
          qty_receiving: 0,
        },
      ],
      "variant-a",
    );
    expect(first.status).toBe("staged");
    expect(first.lines[0].qty_receiving).toBe(1);

    const second = stageReceivingVariantScan(first.lines, "variant-a");
    expect(second.status).toBe("at_limit");
    expect(second.lines[0].qty_receiving).toBe(1);
  });

  test("uses the vendor-scoped exact server resolver for add-line scans", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/inventory/ReceivingBay.tsx"),
      "utf8",
    );

    expect(source).toContain("/api/inventory/receiving-scan-resolve?");
    expect(source).toContain("vendor_id: detail.vendor_id");
    expect(source).toContain("purchase_order_id: poId");
    expect(source).toContain("The server exact resolver is the only authority");
    expect(source.indexOf("await lookupVariantByCode(sku)")).toBeLessThan(
      source.indexOf(
        "stageReceivingVariantScan(linesRef.current, lookup.variant.variant_id)",
      ),
    );
    expect(source).toContain("scanQueueRef.current.then(run, run)");
    expect(source).toContain('import { fetchWithTimeout } from "../../lib/api"');
    expect(source).toContain("const RECEIVING_LOOKUP_TIMEOUT_MS = 8_000");
    expect(source.match(/fetchWithTimeout\(/g)).toHaveLength(2);
    expect(source.match(/RECEIVING_LOOKUP_TIMEOUT_MS/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).not.toContain(
      'return { kind: "exact", variant: uniqueMatches[0] }',
    );
  });

  test("accepts a PO line before attempting any retail-price mutation", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/components/inventory/ReceivingBay.tsx"),
      "utf8",
    );
    const addLineStart = source.indexOf("const addInvoiceLine = useCallback");
    const addLineSource = source.slice(
      addLineStart,
      source.indexOf("// ── Submit", addLineStart),
    );
    expect(
      addLineSource.indexOf("/api/purchase-orders/${poId}/lines"),
    ).toBeLessThan(
      addLineSource.indexOf(
        "/api/products/variants/${selectedVariant.variant_id}/pricing",
      ),
    );
    expect(addLineSource).toContain("lineId: addedLine.line_id");
    expect(addLineSource).toContain(
      "Invoice line added and staged, but retail was not changed",
    );
  });
});
