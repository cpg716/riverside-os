import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { isVerifiedPosScanResult } from "../src/lib/posScanResolution";

const repositoryFile = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Register exposes camera scanning through the existing authoritative scan path", async () => {
  const [cart, scanner] = await Promise.all([
    repositoryFile("client/src/components/pos/Cart.tsx"),
    repositoryFile("client/src/components/inventory/CameraScanner.tsx"),
  ]);

  expect(cart).toContain('import CameraScanner from "../inventory/CameraScanner"');
  expect(cart).toContain('data-testid="pos-camera-scan-button"');
  expect(cart).toContain('aria-label="Scan product with camera"');
  expect(cart).toContain('label="Register Product Scan"');
  expect(cart).toContain("handleLaserScan(code, runSearch)");
  expect(cart).toContain("isVerifiedPosScanResult(result, q)");
  expect(cart).toContain("cameraScannerOpen ||");
  expect(scanner).toContain("useDialogAccessibility");
  expect(scanner).toContain("scanner.isScanning");
  expect(scanner).toContain("scanner.clear()");
});

test("Register auto-adds verified barcode aliases but not name-only matches", () => {
  expect(
    isVerifiedPosScanResult(
      {
        sku: "CANONICAL-100",
        vendor_sku: "",
        resolution_kind: "barcode_alias",
      },
      "012345678901",
    ),
  ).toBe(true);
  expect(
    isVerifiedPosScanResult(
      {
        sku: "CANONICAL-100",
        vendor_sku: "",
        resolution_kind: "product_name",
      },
      "canonical product",
    ),
  ).toBe(false);
  expect(
    isVerifiedPosScanResult(
      { sku: "CANONICAL-100", vendor_sku: "VENDOR-100" },
      "vendor-100",
    ),
  ).toBe(true);
});

test("Register throttles idle activity and focus-manages cart-owned dialogs", async () => {
  const [shell, cart] = await Promise.all([
    repositoryFile("client/src/components/layout/PosShell.tsx"),
    repositoryFile("client/src/components/pos/Cart.tsx"),
  ]);

  expect(shell).toContain("IDLE_ACTIVITY_THROTTLE_MS");
  expect(shell).toContain('"pointermove"');
  expect(shell).not.toContain('"mousemove"');
  for (const dialogRef of [
    "moreSaleActionsDialogRef",
    "orderPaymentEditDialogRef",
    "parkedSalesDialogRef",
    "parkedCustomerDialogRef",
    "printRetryDialogRef",
  ]) {
    expect(cart).toContain(dialogRef);
  }
});

test("Register keeps the current parked-sale count directly available", async () => {
  const [cart, helpManual, staffGuide] = await Promise.all([
    repositoryFile("client/src/components/pos/Cart.tsx"),
    repositoryFile("client/src/assets/docs/pos-manual.md"),
    repositoryFile("docs/staff/pos-register-cart.md"),
  ]);

  expect(cart).toContain('data-testid="pos-parked-sales-button"');
  expect(cart).toContain("Parked Sales · {parkedRows.length}");
  expect(cart).toContain("onClick={() => setParkedListOpen(true)}");
  expect(cart).toContain('data-testid="pos-compact-checkout-open"');
  expect(cart).toContain("Customer &amp; Pay");
  expect(helpManual).toContain("**Parked Sales** remains visible above product search");
  expect(staffGuide).toContain("**Parked Sales** remains visible above product search");
});
