import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repositoryFile = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Register exposes camera scanning through the existing authoritative scan path", async () => {
  const cart = await repositoryFile("client/src/components/pos/Cart.tsx");

  expect(cart).toContain('import CameraScanner from "../inventory/CameraScanner"');
  expect(cart).toContain('data-testid="pos-camera-scan-button"');
  expect(cart).toContain('aria-label="Scan product with camera"');
  expect(cart).toContain('label="Register Product Scan"');
  expect(cart).toContain("handleLaserScan(code, runSearch)");
  expect(cart).toContain("cameraScannerOpen ||");
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
  expect(helpManual).toContain("**Parked Sales** remains visible above product search");
  expect(staffGuide).toContain("**Parked Sales** remains visible above product search");
});
