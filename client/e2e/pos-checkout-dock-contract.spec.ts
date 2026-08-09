import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const cartSource = readFileSync(
  new URL("../src/components/pos/Cart.tsx", import.meta.url),
  "utf8",
);

test("keeps the full-size keypad and payment action in a fixed bottom dock", () => {
  const scrollRegion = cartSource.indexOf(
    'data-testid="pos-checkout-rail-scroll"',
  );
  const checkoutDock = cartSource.indexOf('data-testid="pos-checkout-dock"');
  const keypad = cartSource.indexOf('data-testid="pos-register-keypad"');
  const paymentAction = cartSource.indexOf('data-testid="pos-pay-button"');

  expect(cartSource).toContain("w-full flex-col overflow-hidden border-l");
  expect(cartSource).toContain(
    "min-h-0 flex-1 overflow-y-auto overscroll-contain",
  );
  expect(scrollRegion).toBeGreaterThan(-1);
  expect(checkoutDock).toBeGreaterThan(scrollRegion);
  expect(keypad).toBeGreaterThan(checkoutDock);
  expect(paymentAction).toBeGreaterThan(keypad);
  expect(cartSource).toContain("h-[24rem] min-h-[24rem]");
  expect(cartSource).toContain("h-[5.75rem] min-h-[5.75rem]");
});
